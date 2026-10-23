'use strict';
const express = require('express');
const inbound = require('../../integrations/inbound');

// Machine-to-machine endpoint: no session; authenticated by HMAC signature + timestamp + idempotent event ids.
module.exports = (ctx, { wrap }) => {
  const r = express.Router();
  r.post('/:source/webhook', wrap(async (req, res) => {
    const out = await inbound.receive(ctx, req.params.source, req.rawBody || '', req.headers['x-findway-signature']);
    res.status(200).json(out);
  }));
  return r;
};
