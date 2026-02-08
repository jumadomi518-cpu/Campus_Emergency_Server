
 const { Router } = require("express");
 const registerRouter = Router();
 const registerController = require('../controllers/registerController.js');
 const confirmOtpController = require('../controllers/confirmOtp.js');
 const resendOtp = require("../controllers/resendOtp.js");



 registerRouter.post("/", registerController);

 registerRouter.post("/confirmOtp", confirmOtpController);

 registerRouter.post("/resendOtp", resendOtp);


 module.exports = registerRouter;

