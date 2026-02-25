const express = require("express");
const router = express.Router();

router.post("/login", (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "username is required" });
  }

  return res.json({ message: "Login successful", username });
});

module.exports = router;
