const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Render provides the database URL in the environment variables
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Auto-initialize tables when the server starts
const initDB = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS allowed_guilds (guild_name VARCHAR(50) PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS staff_players (player_name VARCHAR(50) PRIMARY KEY);
    `);
    console.log("Database tables verified.");
};
initDB();

// 1. Authenticate Player
app.post('/api/auth', async (req, res) => {
    const { playerName, guildWords } = req.body;
    
    try {
        // Check if the player is staff
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE player_name = $1', [playerName]);
        const isStaff = staffRes.rowCount > 0;

        let isWhitelisted = isStaff; // Staff always get access

        // Check if any of the parsed words from their "g who" message matches an allowed guild
        if (!isWhitelisted && guildWords && guildWords.length > 0) {
            const guildRes = await pool.query('SELECT guild_name FROM allowed_guilds WHERE guild_name = ANY($1)', [guildWords]);
            if (guildRes.rowCount > 0) isWhitelisted = true;
        }

        res.json({ isWhitelisted, isStaff });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Fetch Allowed Guilds (For the Access Tab)
app.get('/api/guilds', async (req, res) => {
    try {
        const result = await pool.query('SELECT guild_name FROM allowed_guilds ORDER BY guild_name ASC');
        res.json(result.rows.map(row => row.guild_name));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Add a Guild (Requires Staff)
app.post('/api/guilds', async (req, res) => {
    const { playerName, guildName } = req.body;
    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE player_name = $1', [playerName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query('INSERT INTO allowed_guilds (guild_name) VALUES ($1) ON CONFLICT DO NOTHING', [guildName.toLowerCase()]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Remove a Guild (Requires Staff)
app.delete('/api/guilds/:name', async (req, res) => {
    const { playerName } = req.body;
    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE player_name = $1', [playerName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query('DELETE FROM allowed_guilds WHERE guild_name = $1', [req.params.name.toLowerCase()]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));