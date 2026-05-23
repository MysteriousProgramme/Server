const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Connect to Render's Postgres database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render DB connections
});

// Auto-initialize tables if they don't exist
const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS allowed_guilds (guild_name VARCHAR(50) PRIMARY KEY);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS staff_players (player_name VARCHAR(50) PRIMARY KEY);`);
        
        // NEW: 24-Hour Cache Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS guild_cache (
                guild_name VARCHAR(50) PRIMARY KEY,
                roster JSONB,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// --- NEW CACHE ENDPOINTS ---

// 4. Fetch Roster (Checks Cache Age)
app.get('/api/roster/:guildName', async (req, res) => {
    const { guildName } = req.params;
    try {
        // Extract difference in seconds from last update
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
    try {
        await pool.query(
            `INSERT INTO guild_cache (guild_name, roster, last_updated) 
             VALUES (LOWER($1), $2::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (guild_name) DO UPDATE 
             SET roster = EXCLUDED.roster, last_updated = CURRENT_TIMESTAMP`,
            [guildName, JSON.stringify(roster)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));