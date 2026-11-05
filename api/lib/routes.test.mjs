import assert from "node:assert/strict";
import { test } from "node:test";

import apiHandler from "../[...path].js";
import authHandler from "../auth/[action].js";
import inviteHandler from "../invites/[token].js";
import clientInviteHandler from "../clients/[clientId]/invite.js";
import checkInResponseHandler from "../checkins/[checkinId]/response.js";

test("nested Vercel routes delegate to the shared API handler", () => {
  for (const handler of [authHandler, inviteHandler, clientInviteHandler, checkInResponseHandler]) {
    assert.equal(handler, apiHandler);
  }
});
