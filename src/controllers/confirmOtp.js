

 const bcrypt = require("bcryptjs");
 const { Pool } = require("pg");
 const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized: false }
  });

 async function verifyOtp(email, otp) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = rows[0];
  if (!user) {
    return "User not found";
  }
  if (Date.now() > new Date(user.expires_at).getTime()) {
    return "Otp expired";
  }
  const compare = await bcrypt.compare(otp, user.otp);
  return compare;
}



 async function confirmOtp(req, res) {
  try {
    const { email, otp } = req.body;

    const verified = await verifyOtp(email, otp);

    if (verified === "Otp expired") return res.status(400).json({ status: "Otp expired" });
    if (verified === "User not found") return res.status(404).json({ status: "User not found" });
    if (verified === true) {
      await pool.query("UPDATE users SET status = $1 WHERE email = $2", ["verified", email]);
      return res.json({ status: "success" });
    }

    return res.status(400).json({ status: "don't match" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "internal server error", error: err.message });
  }
}

module.exports = confirmOtp;
