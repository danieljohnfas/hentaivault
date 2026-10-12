const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.all("SELECT sql FROM sqlite_master WHERE type='table'", (err, rows) => {
    if (err) {
        console.error('Error fetching schema:', err);
    } else {
        const schema = rows.map(r => r.sql).join('\n\n');
        fs.writeFileSync('schema_dump.txt', schema);
        console.log('Schema dumped to schema_dump.txt');
    }
    db.close();
});
