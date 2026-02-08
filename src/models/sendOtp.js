const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const axios = require("axios");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function saveOtp(otp, email) {
  const hashedOtp = await bcrypt.hash(otp.toString(), 10);
  const expiry = new Date(Date.now() + 5 * 60 * 1000);

  await pool.query(
    "UPDATE users SET otp = $1, expires_at = $2 WHERE email = $3",
    [hashedOtp, expiry, email]
  );

  console.log("OTP saved successfully");
}

async function sendOtp(email) {
  try {
    const otp = Math.floor(100000 + Math.random() * 900000);

    await saveOtp(otp, email);

    const res = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: "DomTech", email: "domtechpay@gmail.com" },
        to: [{ email }],
        subject: "Email Address Verification",
        htmlContent: `
          <p>Dear Lovely User</p>
          <p>Your OTP is:</p>
          <h2>${otp}</h2>
          <p>This code expires in 5 minutes.</p>
        `
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Email sent", res.data);
  } catch (err) {
    console.error("Send OTP failed:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = sendOtp;
