const express = require("express");
const router = express.Router();
const candidateModel = require("../models/candidateModel");

router.post("/add", async (req, res) => {
  try {
    const newCandidate = await candidateModel.createCandidate(req.body);
    res.json(newCandidate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/all", async (req, res) => {
  try {
    const list = await candidateModel.getAllCandidates();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
