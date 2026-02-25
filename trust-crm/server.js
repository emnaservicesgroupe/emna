require("dotenv").config();
const express = require("express");
const cors = require("cors");

const candidateRoutes = require("./routes/candidates");
const alertRoutes = require("./routes/alerts");
const authRoutes = require("./routes/auth");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/candidates", candidateRoutes);
app.use("/alerts", alertRoutes);
app.use("/auth", authRoutes);

app.listen(process.env.PORT, () => {
  console.log("🚀 CRM Running on port " + process.env.PORT);
});
