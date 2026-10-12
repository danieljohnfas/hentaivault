const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir);
let deletedCount = 0;

files.forEach(file => {
    const p = path.join(uploadsDir, file);
    try {
        const buffer = fs.readFileSync(p);
        const start = buffer.toString('utf8', 0, 50).toLowerCase().trim();
        if (start.includes('<!doctype html') || start.startsWith('<html')) {
            console.log(`Deleting invalid Imgur HTML payload: ${file}`);
            fs.unlinkSync(p);
            deletedCount++;

            const urlPath = `/uploads/${file}`;
            db.run('DELETE FROM posts WHERE image = ?', [urlPath], function (err) {
                if (!err && this.changes > 0) {
                    console.log(`Removed broken post from database: ${urlPath}`);
                }
            });
        }
    } catch (e) {
        console.error(`Error reading ${file}: ` + e.message);
    }
});

setTimeout(() => {
    console.log(`Cleanup finished: ${deletedCount} invalid files removed.`);
    db.close();
}, 2000);
