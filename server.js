const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
// Increase the limit to 50 megabytes to easily handle massive war logs
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// Connect to Render's Postgres database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

// Auto-initialize tables if they don't exist
const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS allowed_guilds (guild_name VARCHAR(50) PRIMARY KEY);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS staff_players (player_name VARCHAR(50) PRIMARY KEY);`);
        
        // 24-Hour Cache Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS guild_cache (
                guild_name VARCHAR(50) PRIMARY KEY,
                roster JSONB,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Sessions Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions_cache (
                session_id VARCHAR(50) PRIMARY KEY,
                session_data JSONB,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Global Broadcast Table (single row, id = 1)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS global_broadcast (
                id INT PRIMARY KEY DEFAULT 1,
                session_id VARCHAR(50)
            );
        `);

        console.log("Database tables verified.");
    } catch (err) {
        console.error("DB Init Error:", err);
    }
};
initDB();

// 1. Authenticate Player & Fetch Data
app.get('/api/auth/:playerName', async (req, res) => {
    const { playerName } = req.params;
    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [playerName]);
        const guildsRes = await pool.query('SELECT guild_name FROM allowed_guilds');
        
        res.json({
            isStaff: staffRes.rowCount > 0,
            allowedGuilds: guildsRes.rows.map(row => row.guild_name.toLowerCase())
        });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// 2. Add a Guild (Staff Action)
app.post('/api/guilds', async (req, res) => {
    const { guildName, staffName } = req.body;
    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query('INSERT INTO allowed_guilds (guild_name) VALUES ($1) ON CONFLICT DO NOTHING', [guildName.toLowerCase()]);
        res.json({ success: true, message: `Added ${guildName}` });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// 3. Remove a Guild (Staff Action)
app.delete('/api/guilds/:guildName', async (req, res) => {
    const { guildName } = req.params;
    const staffName = req.headers['staff-name']; 
    
    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query('DELETE FROM allowed_guilds WHERE LOWER(guild_name) = LOWER($1)', [guildName]);
        res.json({ success: true, message: `Removed ${guildName}` });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// 4. Fetch Roster (Checks Cache Age)
app.get('/api/roster/:guildName', async (req, res) => {
    const { guildName } = req.params;
    try {
        const result = await pool.query(
            `SELECT roster, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_updated)) AS age_seconds 
             FROM guild_cache WHERE LOWER(guild_name) = LOWER($1)`,
            [guildName]
        );
        
        if (result.rowCount > 0) {
            const age = result.rows[0].age_seconds;
            const isStale = age > 86400; // 86,400 seconds = 24 hours
            res.json({ exists: true, stale: isStale, roster: result.rows[0].roster });
        } else {
            res.json({ exists: false, stale: true, roster: [] });
        }
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// 5. Upload/Update Roster
app.post('/api/roster', async (req, res) => {
    const { guildName, roster } = req.body;
    console.log(`[Backend] Received roster upload for '${guildName}'. Player count: ${roster ? roster.length : 0}`);

    try {
        await pool.query(
            `INSERT INTO guild_cache (guild_name, roster, last_updated) 
             VALUES (LOWER($1), $2::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (guild_name) DO UPDATE 
             SET roster = EXCLUDED.roster, last_updated = CURRENT_TIMESTAMP`,
            [guildName, JSON.stringify(roster)]
        );
        console.log(`[Backend] Successfully saved '${guildName}' to database.`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Backend] Database error saving '${guildName}':`, err);
        res.status(500).json({ error: "Database error" });
    }
});

// 6. Upload Session (From Mod)
app.post('/api/sessions', async (req, res) => {
    const { sessionId, sessionData } = req.body;
    
    if (!sessionId || !sessionData) {
        return res.status(400).json({ error: "Missing sessionId or sessionData" });
    }

    try {
        await pool.query(
            `INSERT INTO sessions_cache (session_id, session_data, last_updated) 
             VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (session_id) DO UPDATE 
             SET session_data = EXCLUDED.session_data, last_updated = CURRENT_TIMESTAMP`,
            [sessionId, JSON.stringify(sessionData)]
        );
        console.log(`[Backend] Successfully uploaded session: ${sessionId}`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Backend] Error saving session ${sessionId}:`, err);
        res.status(500).json({ error: "Database error" });
    }
});

// 7. Fetch Session (For Discord Bot)
app.get('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        const result = await pool.query('SELECT session_data FROM sessions_cache WHERE session_id = $1', [sessionId]);
        if (result.rowCount > 0) {
            res.json(result.rows[0].session_data);
        } else {
            res.status(404).json({ error: "Session not found" });
        }
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// ==========================================
// PUBLIC API ROUTES (For the In-Game Mod UI)
// ==========================================

// 8. Fetch ALL Sessions for the API Tab
app.get('/api/v1/sessions', async (req, res) => {
    const { type, status } = req.query;
    
    try {
        let queryText = 'SELECT session_id, session_data, last_updated FROM sessions_cache WHERE 1=1';
        const queryParams = [];
        let paramIndex = 1;

        if (type) {
            queryText += ` AND session_data->>'type' = $${paramIndex}`;
            queryParams.push(type);
            paramIndex++;
        }

        if (status) {
            queryText += ` AND session_data->>'status' = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        queryText += ' ORDER BY last_updated DESC';

        const result = await pool.query(queryText, queryParams);
        
        res.json({
            success: true,
            count: result.rowCount,
            data: result.rows.map(row => ({
                sessionId: row.session_id,
                sessionData: row.session_data,
                lastUpdated: row.last_updated
            }))
        });

    } catch (err) {
        console.error("[Public API] Error fetching sessions:", err);
        res.status(500).json({ error: "Database error fetching sessions" });
    }
});

// 9. Delete API Session (Requires Staff Auth)
app.delete('/api/v1/sessions/:id', async (req, res) => {
    const { id } = req.params;
    const staffName = req.headers['staff-name'];

    if (!staffName) {
        return res.status(400).json({ error: "Missing staff-name header" });
    }

    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        
        if (staffRes.rowCount === 0) {
            return res.status(403).json({ error: "Unauthorized: Only staff members can delete API sessions." });
        }

        const deleteRes = await pool.query('DELETE FROM sessions_cache WHERE session_id = $1', [id]);

        // Auto-clear the global broadcast if it pointed at this session
        await pool.query('UPDATE global_broadcast SET session_id = NULL WHERE session_id = $1', [id]);

        if (deleteRes.rowCount > 0) {
            console.log(`[Public API] Session ${id} deleted by staff member ${staffName}`);
            res.json({ success: true, message: `Session ${id} successfully deleted.` });
        } else {
            res.status(404).json({ error: "Session not found." });
        }

    } catch (err) {
        console.error(`[Public API] Error deleting session ${id}:`, err);
        res.status(500).json({ error: "Database error deleting session" });
    }
});

// ==========================================
// GLOBAL BROADCAST ROUTES
// Declared BEFORE "/api/v1/sessions/:id" GET routes so "/api/v1/global"
// is never captured as a session id. (Express matches in declaration order.)
// ==========================================

// 9b. Set the global broadcast (Staff only)
app.post('/api/v1/global/:id', async (req, res) => {
    const { id } = req.params;
    const staffName = req.headers['staff-name'];
    if (!staffName) return res.status(400).json({ error: "Missing staff-name header" });

    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query(
            `INSERT INTO global_broadcast (id, session_id) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id`,
            [id]
        );
        console.log(`[Global] Broadcast set to session ${id} by ${staffName}`);
        res.json({ success: true, sessionId: id });
    } catch (err) {
        console.error("[Global] set error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 9c. Clear the global broadcast (Staff only) — turns everyone's HUD off
app.delete('/api/v1/global', async (req, res) => {
    const staffName = req.headers['staff-name'];
    if (!staffName) return res.status(400).json({ error: "Missing staff-name header" });

    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query('UPDATE global_broadcast SET session_id = NULL WHERE id = 1');
        console.log(`[Global] Broadcast cleared by ${staffName}`);
        res.json({ success: true });
    } catch (err) {
        console.error("[Global] clear error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 9d. Get the active global broadcast (Public — polled by every client every 10s).
// Returns { active:false } when nothing is broadcast OR the session no longer exists,
// which is how clients know to remove the HUD.
app.get('/api/v1/global', async (req, res) => {
    try {
        const gb = await pool.query('SELECT session_id FROM global_broadcast WHERE id = 1');
        const sessionId = gb.rowCount > 0 ? gb.rows[0].session_id : null;
        if (!sessionId) return res.json({ active: false });

        const sess = await pool.query('SELECT session_data FROM sessions_cache WHERE session_id = $1', [sessionId]);
        if (sess.rowCount === 0) return res.json({ active: false });

        res.json({ active: true, sessionId, sessionData: sess.rows[0].session_data });
    } catch (err) {
        console.error("[Global] get error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 10. Fetch Single Specific Session
app.get('/api/v1/sessions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT session_data, last_updated FROM sessions_cache WHERE session_id = $1', [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        
        res.json({ 
            success: true, 
            sessionId: id, 
            lastUpdated: result.rows[0].last_updated,
            data: result.rows[0].session_data 
        });
    } catch (err) {
        console.error(`[Public API] Error fetching session ${id}:`, err);
        res.status(500).json({ error: "Database error" });
    }
});

// 11. Fetch Leaderboard for a Session (Supports ?top= amount and adds medal colors)
app.get('/api/v1/sessions/:id/leaderboard', async (req, res) => {
    const { id } = req.params;
    const topLimit = parseInt(req.query.top) || 0; 
    
    try {
        const result = await pool.query('SELECT session_data FROM sessions_cache WHERE session_id = $1', [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        
        const sessionData = result.rows[0].session_data;
        const playersObj = sessionData.players || {};
        
        let playersArray = Object.values(playersObj);
        
        playersArray.sort((a, b) => {
            if (b.kills !== a.kills) return b.kills - a.kills;
            return a.deaths - b.deaths;
        });
        
        if (topLimit > 0) {
            playersArray = playersArray.slice(0, topLimit);
        }
        
        const leaderboard = playersArray.map((p, index) => {
            const rank = index + 1;
            let medal = "none";
            let colorCode = "Â§f"; 
            
            if (rank === 1) { 
                medal = "gold"; 
                colorCode = "Â§6"; 
            } else if (rank === 2) { 
                medal = "silver"; 
                colorCode = "Â§7"; 
            } else if (rank === 3) { 
                medal = "bronze"; 
                colorCode = "Â§c"; 
            }
            
            return {
                rank,
                medal,
                colorCode,
                name: p.name,
                kills: p.kills,
                deaths: p.deaths,
                kd: p.deaths === 0 ? p.kills : parseFloat((p.kills / p.deaths).toFixed(2))
            };
        });
        
        res.json({ 
            success: true, 
            sessionId: id, 
            leaderboard 
        });
    } catch (err) {
        console.error(`[Public API] Error generating leaderboard for session ${id}:`, err);
        res.status(500).json({ error: "Database error" });
    }
});

// 12. Fetch Live Active Updates (Returns Top 10)
app.get('/api/v1/sessions/:id/active', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT session_data, last_updated FROM sessions_cache WHERE session_id = $1', [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        
        const sessionData = result.rows[0].session_data;
        const playersObj = sessionData.players || {};
        
        let playersArray = Object.values(playersObj);
        
        playersArray.sort((a, b) => {
            if (b.kills !== a.kills) return b.kills - a.kills;
            return a.deaths - b.deaths;
        });
        
        const top10 = playersArray.slice(0, 10).map((p, index) => {
            const rank = index + 1;
            return {
                rank,
                name: p.name,
                kills: p.kills,
                deaths: p.deaths
            };
        });
        
        res.json({ 
            success: true, 
            sessionId: id, 
            status: "active",
            lastUpdated: result.rows[0].last_updated,
            top10 
        });
    } catch (err) {
        console.error(`[Public API] Error fetching live active session ${id}:`, err);
        res.status(500).json({ error: "Database error" });
    }
});

// 13. Remove Live Session (Auto-cleanup when stopping track)
app.delete('/api/sessions/live/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM sessions_cache WHERE session_id = $1', [id]);

        // Auto-clear the global broadcast if it pointed at this session
        await pool.query('UPDATE global_broadcast SET session_id = NULL WHERE session_id = $1', [id]);

        res.json({ success: true });
    } catch (err) {
        console.error(`[Backend] Error auto-deleting live session ${id}:`, err);
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
