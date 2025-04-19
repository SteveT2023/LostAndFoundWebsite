-- Ensure the Item table exists and has a primary key
CREATE TABLE IF NOT EXISTS Item (
    item_id INT AUTO_INCREMENT PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    image_path VARCHAR(255),
    user_id INT NOT NULL,
    status ENUM('Lost', 'Claimed') DEFAULT 'Lost'
);

-- Ensure the Claim table exists and references the Item table
CREATE TABLE IF NOT EXISTS Claim (
    claim_id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NOT NULL,
    user_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    proof_description TEXT NOT NULL,
    claim_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status ENUM('Pending', 'Approved', 'Rejected') DEFAULT 'Pending',
    FOREIGN KEY (item_id) REFERENCES Item(item_id) ON DELETE CASCADE
);
