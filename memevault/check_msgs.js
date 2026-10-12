const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('Checking messages in database...');

db.all("SELECT * FROM messages ORDER BY id DESC LIMIT 10", (err, rows) => {
    if (err) {
        console.error('Error fetching messages:', err);
    } else {
        console.log(`Found ${rows.length} recent messages:`);
        rows.forEach(row => {
            console.log(`[${row.id}] ${row.username}: ${row.text} (${row.created_at})`);
        });
    }
    db.close();
});
