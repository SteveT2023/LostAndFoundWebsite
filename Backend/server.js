const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const fs = require('fs');
const Fuse = require('fuse.js');

const app = express();

const upload = multer({
    dest: path.join(__dirname, '../uploads'),
    limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../Frontend')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true
}));

// Create a MySQL connection.
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '002551764',
    database: 'LostAndFound'
});

db.connect(err => {
    if (err) throw err;
    console.log('Connected to database');
});

app.get('/', (req, res) => {
    res.redirect('/login.html');
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/login.html'));
});

app.get('/signup.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/signup.html'));
});

// Insert user login into the database.
app.post('/signup', (req, res) => {
    const { name, email, password, phone_number } = req.body;
    const query = 'INSERT INTO User (name, email, password, phone_number) VALUES (?, ?, ?, ?)';
    db.query(query, [name, email, password, phone_number], (err, result) => {
        if (err) {
            console.error(err);
            res.status(500).send('Error saving user to database');
        } else {
            res.redirect('/login.html');
        }
    });
});

// User credentials verification.
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const query = 'SELECT user_id, name, password FROM User WHERE email = ?';
    db.query(query, [email], (err, results) => {
        if (err || results.length === 0) {
            console.error(err || 'User not found');
            res.status(401).send('Invalid login credentials');
        } else {
            const dbPassword = results[0].password; 
            if (dbPassword === password) {
                req.session.userId = results[0].user_id;
                req.session.userName = results[0].name;
                res.redirect('/homepage.html');
            } else {
                res.status(401).send('Invalid login credentials');
            }
        }
    });
});

app.get('/getUserName', (req, res) => {
    if (req.session.userName) {
        res.json({ name: req.session.userName });
    } else {
        res.status(401).send('User not logged in');
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            res.status(500).send('Error logging out');
        } else {
            res.status(200).send('Logged out successfully');
        }
    });
});

// Insert lost item into the database.
app.post('/reportLostItem', upload.single('image_file'), async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('User not logged in');
    }

    const { item_name, description } = req.body;
    const user_id = req.session.userId;
    let image_path = null;

    if (req.file) {
        const originalPath = req.file.path;
        const convertedPath = `${originalPath}.jpeg`;

        try {
            if (req.file.mimetype === 'image/heic' || req.file.mimetype === 'image/heif') {
                const inputBuffer = await fs.promises.readFile(originalPath);
                const outputBuffer = await heicConvert({
                    buffer: inputBuffer,
                    format: 'JPEG',
                    quality: 1,
                });
                await fs.promises.writeFile(convertedPath, outputBuffer);
            } else {
                await sharp(originalPath)
                    .toFormat('jpeg')
                    .toFile(convertedPath);
            }

            console.log(`Image converted: ${convertedPath}`); 
            image_path = `/uploads/${path.basename(convertedPath)}`;
        } catch (err) {
            console.error('Error converting image:', err);
            return res.status(500).send('Error processing image file');
        }
    }

    if (!item_name || !description) {
        return res.status(400).send('Missing required fields');
    }

    const query = 'INSERT INTO Item (item_name, description, image_path, user_id, status) VALUES (?, ?, ?, ?, "Lost")';
    db.query(query, [item_name, description, image_path, user_id], (err, result) => {
        if (err) {
            console.error('Error inserting item into database:', err);
            res.status(500).send('Error reporting lost item');
        } else {
            res.status(200).send('Lost item reported successfully');
        }
    });
});

app.get('/getUserItems', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('User not logged in');
    }

    const user_id = req.session.userId;
    const query = `
        SELECT i.item_id, i.item_name, 
               CASE 
                   WHEN i.status = 'Lost' AND EXISTS (
                       SELECT 1 FROM Claim c WHERE c.item_id = i.item_id AND c.status = 'Pending'
                   ) THEN 'Request Notice'
                   ELSE i.status
               END AS status,
               i.description, i.image_path, 'You' AS user_name
        FROM Item i
        WHERE i.user_id = ?
    `;
    db.query(query, [user_id], (err, results) => {
        if (err) {
            console.error('Error fetching user items:', err);
            res.status(500).send('Error fetching items');
        } else {
            console.log('Fetched user items:', results);
            res.json({ items: results });
        }
    });
});

app.get('/getLostItems', (req, res) => {
    const query = `
        SELECT i.item_id, i.item_name, i.description, i.image_path, u.name AS user_name
        FROM Item i
        JOIN User u ON i.user_id = u.user_id
        WHERE i.status = 'Lost'
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching lost items:', err);
            res.status(500).send('Error fetching lost items');
        } else {
            res.json({ items: results });
        }
    });
});

// Advance Feature: Smart Suggestion Matching
app.get('/searchLostItems', (req, res) => {
    const { query } = req.query;

    if (!query) {
        return res.status(400).send('Missing search query');
    }

    const dbQuery = `
        SELECT i.item_id, i.item_name, i.description, i.image_path, u.name AS user_name
        FROM Item i
        JOIN User u ON i.user_id = u.user_id
        WHERE i.status = 'Lost'
    `;

    db.query(dbQuery, (err, results) => {
        if (err) {
            console.error('Error fetching lost items:', err);
            return res.status(500).send('Error fetching lost items');
        }

        const fuse = new Fuse(results, {
            keys: ['item_name', 'description', 'user_name'],
            threshold: 0.4,
        });

        const filteredResults = fuse.search(query).map(result => result.item);
        res.json({ items: filteredResults });
    });
});

app.post('/sendClaimRequest', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('User not logged in');
    }

    const { item_id, email, phone_number, proof_description } = req.body;
    const user_id = req.session.userId;

    const queryCheckOwner = 'SELECT user_id FROM Item WHERE item_id = ?';
    db.query(queryCheckOwner, [item_id], (err, results) => {
        if (err) {
            console.error('Error checking item owner:', err);
            return res.status(500).send('Error processing claim request');
        }

        if (results.length === 0) {
            return res.status(404).send('Item not found');
        }

        if (results[0].user_id === user_id) {
            return res.status(403).send('You cannot send a claim request for your own item');
        }

        const query1 = `
            INSERT INTO Claim (item_id, user_id, email, phone_number, proof_description, claim_date, status)
            VALUES (?, ?, ?, ?, ?, NOW(), 'Pending')
        `;
        const query2 = 'UPDATE Item SET status = "Request Notice" WHERE item_id = ? AND status = "Lost"';

        db.beginTransaction(err => {
            if (err) {
                console.error('Error starting transaction:', err);
                return res.status(500).send('Error processing claim request');
            }

            db.query(query1, [item_id, user_id, email, phone_number, proof_description], (err, result) => {
                if (err) {
                    console.error('Error inserting claim:', err);
                    return db.rollback(() => res.status(500).send('Error sending claim request'));
                }

                db.query(query2, [item_id], (err, result) => {
                    if (err) {
                        console.error('Error updating item status:', err);
                        return db.rollback(() => res.status(500).send('Error updating item status'));
                    }

                    console.log('Rows affected by status update:', result.affectedRows); 

                    if (result.affectedRows === 0) {
                        console.warn('No rows updated. Item may not exist or status is not "Lost".');
                    }

                    db.commit(err => {
                        if (err) {
                            console.error('Error committing transaction:', err);
                            return db.rollback(() => res.status(500).send('Error processing claim request'));
                        }

                        res.status(200).send('Claim request sent successfully and item status updated to "Request Notice"');
                    });
                });
            });
        });
    });
});

app.post('/submitClaim', upload.none(), (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('User not logged in');
    }

    console.log('Request body:', req.body);

    const { item_id, email, phone_number, proof_description } = req.body;

    console.log('Received item_id:', item_id);
    console.log('Received email:', email);
    console.log('Received phone_number:', phone_number); 
    console.log('Received proof_description:', proof_description);

    if (!item_id || isNaN(parseInt(item_id))) {
        console.error('Invalid item_id:', item_id); 
        return res.status(400).send('Invalid item_id');
    }

    if (!email || !phone_number || !proof_description) {
        console.error('Missing required fields'); 
        return res.status(400).send('Missing required fields');
    }

    const user_id = req.session.userId;
    const claim_date = new Date(); 
    const status = 'Pending'; 

    const query = `
        INSERT INTO Claim (item_id, user_id, email, phone_number, proof_description, claim_date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    db.query(query, [parseInt(item_id), user_id, email, phone_number, proof_description, claim_date, status], (err, result) => {
        if (err) {
            console.error('Error inserting claim:', err);
            res.status(500).send('Error submitting claim');
        } else {
            console.log('Claim submitted successfully');
            res.status(200).send('Claim submitted successfully');
        }
    });
});

app.get('/getClaims', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('User not logged in');
    }

    const query = `
        SELECT claim_id, claim_date, item_id, email, phone_number, proof_description, status
        FROM Claim
        WHERE user_id = ?
    `;
    db.query(query, [req.session.userId], (err, results) => {
        if (err) {
            console.error('Error fetching claims:', err);
            res.status(500).send('Error fetching claims');
        } else {
            res.json({ claims: results });
        }
    });
});

app.get('/getUserClaims', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('User not logged in');
    }

    const query = `
        SELECT c.claim_id, i.item_name, c.status
        FROM Claim c
        JOIN Item i ON c.item_id = i.item_id
        WHERE c.user_id = ?
    `;
    db.query(query, [req.session.userId], (err, results) => {
        if (err) {
            console.error('Error fetching user claims:', err);
            res.status(500).send('Error fetching claims');
        } else {
            res.json({ claims: results });
        }
    });
});

app.get('/getClaimDetails', (req, res) => {
    const { item_id } = req.query;

    if (!item_id) {
        return res.status(400).send('Missing item_id');
    }

    const query = `
        SELECT c.claim_id, c.email, c.phone_number, c.proof_description
        FROM Claim c
        WHERE c.item_id = ? AND c.status = 'Pending'
    `;
    db.query(query, [item_id], (err, results) => {
        if (err) {
            console.error('Error fetching claim details:', err);
            res.status(500).send('Error fetching claim details');
        } else if (results.length === 0) {
            res.status(404).send('No claim details found for this item');
        } else {
            res.json(results[0]);
        }
    });
});

app.post('/claimItem', (req, res) => {
    const { item_id } = req.body;

    if (!item_id) {
        return res.status(400).send('Missing item_id');
    }

    const query = 'UPDATE Item SET status = "Claimed" WHERE item_id = ?';
    db.query(query, [item_id], (err, result) => {
        if (err) {
            console.error('Error claiming item:', err);
            res.status(500).send('Error claiming item');
        } else {
            res.status(200).send('Item successfully claimed');
        }
    });
});

app.post('/rejectClaim', (req, res) => {
    const { item_id } = req.body;

    if (!item_id) {
        return res.status(400).send('Missing item_id');
    }

    const query = 'DELETE FROM Claim WHERE item_id = ? AND status = "Pending"';
    db.query(query, [item_id], (err, result) => {
        if (err) {
            console.error('Error rejecting claim:', err);
            res.status(500).send('Error rejecting claim');
        } else {
            res.status(200).send('Claim successfully rejected');
        }
    });
});

app.post('/approveClaim', (req, res) => {
    const { claim_id } = req.body;

    if (!claim_id) {
        console.error('Missing claim_id');
        return res.status(400).send('Missing claim_id');
    }

    console.log('Received claim_id:', claim_id);

    const queryGetItemId = 'SELECT item_id FROM Claim WHERE claim_id = ? AND status = "Pending"';
    const queryApproveClaim = 'UPDATE Claim SET status = "Approved" WHERE claim_id = ? AND status = "Pending"';
    const queryDeleteItem = 'DELETE FROM Item WHERE item_id = ?';

    db.beginTransaction(err => {
        if (err) {
            console.error('Error starting transaction:', err);
            return res.status(500).send('Error processing approval');
        }

        db.query(queryGetItemId, [claim_id], (err, results) => {
            if (err) {
                console.error('Error fetching item_id:', err);
                return db.rollback(() => res.status(500).send('Error fetching item_id'));
            }

            if (results.length === 0) {
                console.warn('Claim not found or already approved');
                return db.rollback(() => res.status(404).send('Claim not found or already approved'));
            }

            const item_id = results[0].item_id;

            db.query(queryApproveClaim, [claim_id], (err, result) => {
                if (err) {
                    console.error('Error approving claim:', err);
                    return db.rollback(() => res.status(500).send('Error approving claim'));
                }

                db.query(queryDeleteItem, [item_id], (err, result) => {
                    if (err) {
                        console.error('Error deleting item:', err);
                        return db.rollback(() => res.status(500).send('Error deleting item'));
                    }

                    db.commit(err => {
                        if (err) {
                            console.error('Error committing transaction:', err);
                            return db.rollback(() => res.status(500).send('Error processing approval'));
                        }

                        console.log('Claim approved and item deleted successfully');
                        res.status(200).send('Claim approved and item deleted successfully');
                    });
                });
            });
        });
    });
});

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
