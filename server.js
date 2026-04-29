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
        // Verify the user making the request is actually staff
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
    const staffName = req.headers['staff-name']; // Passed in headers for DELETE requests
    
    try {
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        if (staffRes.rowCount === 0) return res.status(403).json({ error: "Unauthorized" });

        await pool.query('DELETE FROM allowed_guilds WHERE LOWER(guild_name) = LOWER($1)', [guildName]);
        res.json({ success: true, message: `Removed ${guildName}` });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));