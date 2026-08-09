import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyInboundMessage,
  computeTwilioSignature,
  isE164,
  TwilioClient,
  SmsSendError,
  validateTwilioSignature,
} from "../src/services/delivery/sms";

describe("E.164 validation", () => {
  it("accepts real-shaped numbers", () => {
    for (const number of ["+14065550123", "+442071838750", "+61255501234"]) {
      assert.equal(isE164(number), true, number);
    }
  });

  it("rejects anything a carrier would not route", () => {
    for (const number of [
      "4065550123", // no +
      "+0405550123", // leading zero country code
      "+14065", // too short: E.164 allows 7-15 digits
      "+1406555012345678", // too long
      "+1 406 555 0123", // spaces
      "+1-406-555-0123",
      "",
    ]) {
      assert.equal(isE164(number), false, number);
    }
  });
});

describe("TwilioClient", () => {
  const options = {
    accountSid: "AC-test",
    authToken: "token-test",
    fromNumber: "+15005550006",
    baseUrl: "https://api.example.invalid/2010-04-01",
  };

  it("refuses to send when it is not configured, and says so without retrying", async () => {
    const client = new TwilioClient({ accountSid: "", authToken: "", fromNumber: "", fetchImpl: async () => {
      throw new Error("must not be called");
    } });

    await assert.rejects(
      () => client.send("+14065550123", "hello"),
      (err: unknown) => {
        assert.ok(err instanceof SmsSendError);
        assert.equal(err.retryable, false, "a missing credential is not a transient failure");
        return true;
      },
    );
  });

  it("posts form-encoded with basic auth, and never in the URL", async () => {
    const urls: string[] = [];
    const inits: Array<{ method: string; headers: Record<string, string>; body: string }> = [];

    const client = new TwilioClient({
      ...options,
      fetchImpl: async (url, init) => {
        urls.push(url);
        inits.push(init);
        return { ok: true, status: 201, text: async () => "" };
      },
    });

    await client.send("+14065550123", "CommissionWatch: test");

    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://api.example.invalid/2010-04-01/Accounts/AC-test/Messages.json");
    assert.equal(inits[0].method, "POST");
    assert.equal(inits[0].headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.match(inits[0].headers.Authorization, /^Basic /);
    // The credential belongs in the header, never in a URL that lands in logs.
    assert.equal(urls[0].includes("token-test"), false);

    const body = new URLSearchParams(inits[0].body);
    assert.equal(body.get("To"), "+14065550123");
    assert.equal(body.get("From"), "+15005550006");
    assert.equal(body.get("Body"), "CommissionWatch: test");
  });

  it("rejects a non-E.164 destination before spending a request", async () => {
    let calls = 0;
    const client = new TwilioClient({
      ...options,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 201, text: async () => "" };
      },
    });

    await assert.rejects(() => client.send("4065550123", "hi"), /E.164/);
    assert.equal(calls, 0, "a malformed number must not reach the API");
  });

  it("treats 429 and 5xx as retryable and 4xx as not", async () => {
    async function attempt(status: number): Promise<SmsSendError> {
      const client = new TwilioClient({
        ...options,
        fetchImpl: async () => ({ ok: false, status, text: async () => "detail" }),
      });
      try {
        await client.send("+14065550123", "hi");
      } catch (err) {
        assert.ok(err instanceof SmsSendError);
        return err;
      }
      throw new Error("expected a rejection");
    }

    assert.equal((await attempt(429)).retryable, true);
    assert.equal((await attempt(503)).retryable, true);
    // Retrying a bad request costs money and fails identically every time.
    assert.equal((await attempt(400)).retryable, false);
    assert.equal((await attempt(401)).retryable, false);
  });
});

describe("Twilio request signatures", () => {
  const token = "auth-token-under-test";
  const url = "https://commissionwatch.example/api/sms/inbound";
  const params = { From: "+14065550123", Body: "STOP", MessageSid: "SM1" };

  it("accepts the signature it computes", () => {
    const signature = computeTwilioSignature(token, url, params);
    assert.equal(validateTwilioSignature(token, url, params, signature), true);
  });

  it("is independent of parameter order", () => {
    const a = computeTwilioSignature(token, url, { From: "+1", Body: "STOP" });
    const b = computeTwilioSignature(token, url, { Body: "STOP", From: "+1" });
    assert.equal(a, b);
  });

  it("rejects a tampered body, a wrong token, a wrong URL and a missing signature", () => {
    const signature = computeTwilioSignature(token, url, params);

    assert.equal(
      validateTwilioSignature(token, url, { ...params, Body: "START" }, signature),
      false,
      "changing the body must invalidate the signature",
    );
    assert.equal(validateTwilioSignature("other-token", url, params, signature), false);
    assert.equal(validateTwilioSignature(token, `${url}x`, params, signature), false);
    assert.equal(validateTwilioSignature(token, url, params, undefined), false);
    assert.equal(validateTwilioSignature("", url, params, signature), false);
  });
});

describe("inbound keyword classification", () => {
  it("treats every carrier stop word as a stop, whatever the casing", () => {
    for (const word of ["STOP", "stop", " Stop ", "STOPALL", "unsubscribe", "CANCEL", "end", "QUIT"]) {
      assert.equal(classifyInboundMessage(word), "stop", word);
    }
  });

  it("recognises the resubscribe words", () => {
    for (const word of ["START", "start", "YES", "unstop"]) {
      assert.equal(classifyInboundMessage(word), "start", word);
    }
  });

  it("recognises HELP, and treats anything else as unknown", () => {
    assert.equal(classifyInboundMessage("HELP"), "help");
    assert.equal(classifyInboundMessage("info"), "help");
    assert.equal(classifyInboundMessage("stop it"), "unknown");
    assert.equal(classifyInboundMessage("hello there"), "unknown");
  });
});
