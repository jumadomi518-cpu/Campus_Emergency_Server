
 const { Router } = require("express");
 const locationsRouter = Router();
 const { Pool } = require("pg");
 const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
  });
const CryptoJS = require("crypto-js");

 locationsRouter.get("/", async (req, res) => {
    try {
  const { rows } = await pool.query("SELECT * FROM locations");
  res.json(rows);
  } catch (err) {
  res.json({ status: err.message})

   }
    });


 function encrypt(text) {
 const encrypted = CryptoJS.AES.encrypt(text, process.env.SECRET).toString();
 return encrypted;
  }


locationsRouter.post("/add-location", async (req, res) => {

 const client = await pool.connect();
  try {
  const { name, latitude, longitude, shortCode, transactionType, accountRefference, consumerKey, consumerSecret, passKey } = req.body;
 await client.query("BEGIN");
 const locationResult = await client.query("INSERT INTO locations (location_name, latitude, longitude) VALUES ($1, $2, $3) RETURNING location_id", [ name, latitude, longitude ]);
const locationId = locationResult.rows[0].location_id;
await client.query("INSERT INTO secrets (location_id, short_code, consumer_key, consumer_secret, pass_key, transaction_type, account_ref) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    locationId,
    shortCode,
    encrypt(consumerKey),
    encrypt(consumerSecret),
    encrypt(passKey),
    transactionType,
    accountRefference
   ]);
 await client.query("COMMIT");
 res.json({ status: "success"});
  } catch (err) {
   res.status(500).json({ status: "An error occured"});
   await client.query("ROLLBACk");
   } finally {
   await client.release()
 }


   });


 module.exports = locationsRouter;
