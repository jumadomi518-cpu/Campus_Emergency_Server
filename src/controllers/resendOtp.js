
 const { Pool } = require("pg");
 const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
   })
const bcrypt = require("bcryptjs");

const axios = require("axios");



 async function resendOtp(req, res) {
 try {
 const email = req.body.email;
 const time = Date.now() + 5 * 60 * 1000;
 const otp = Math.floor(Math.random() * 900000 + 100000);
 const hashedOtp = await bcrypt.hash(otp.toString(), 10);
 await pool.query("UPDATE users SET otp = $1, expires_at = $2 WHERE email = $3", [hashedOtp, time, email]);

 const response = await axios.post("https://api.brevo.com/v3/smtp/email", {
   sender: { email: "domtechpay@gmail.com", name: "DomTech"},
   to: [{ email }],
  subject: "Email verification Code",
 htmlContent: `
 <p>Dear Lovely User</p>
 <p>Use the following code as your One Time Password</p>
 <h2><p>OTP: </p>${otp}</h2>
 <p><b>Note: </b>The code expires whithin 5 minutes and cannot be reused</p>`
   },
 {
headers: {
"api-key": process.env.BREVO_API_KEY,
"Content-Type": "Application/json"
}

}
 );

res.json({status: "success"});

  } catch (err) {
console.log(err);
res.json({ status: "internal server error"})

}


    }
module.exports = resendOtp;
