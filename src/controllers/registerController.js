

 const addUser = require('../models/addUser.js');
 const sendOtp = require('../models/sendOtp.js');

 async function registerController(req, res) {

 try {
  let isUserAdded = await addUser(req.body);
 if (isUserAdded === "user added successfully") {
  await sendOtp(req.body.email);
  return res.json({ status: "success"});
}

  return res.json({status: isUserAdded});
 } catch (err) {
 return res.json({status: "error"});
 }



  }
module.exports = registerController;
