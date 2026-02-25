exports.scoreCandidate = (candidate) => {
  let score = 0;

  if (candidate.passport_expiry) score += 20;
  if (candidate.b3_expiry) score += 20;
  if (candidate.embassy_date) score += 20;
  if (candidate.work_company) score += 20;
  if (candidate.visa_status === "Pending") score += 20;

  return score >= 80 ? "Hot" : score >= 50 ? "Warm" : "Cold";
};
