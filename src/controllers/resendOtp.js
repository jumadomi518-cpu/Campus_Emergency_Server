async function resendOtp(req, res) {
  try {
    const { email } = req.body;

    const otp = Math.floor(100000 + Math.random() * 900000);
    const hashedOtp = await bcrypt.hash(otp.toString(), 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const result = await pool.query(
      "UPDATE users SET otp = $1, expires_at = $2 WHERE email = $3 RETURNING id",
      [hashedOtp, expiresAt, email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: "email not found" });
    }

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { email: "domtechpay@gmail.com", name: "DomTech" },
        to: [{ email }],
        subject: "Email verification Code",
        htmlContent: `
<p>Dear lovely user</p>
<p>Use the following One Time Password to verify your Email address</p>
<h2>OTP: ${otp}</h2><p>This code expires in 5 minutes</p>
`
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ status: "success" });

  } catch (err) {
    console.error("Resend OTP error:", err.message);
    res.status(500).json({ status: "internal server error" });
  }
}


module.exports = resendOtp;
