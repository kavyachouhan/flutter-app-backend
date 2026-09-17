# Adding an OTP delivery provider

The vendor that carries the one-time code to the person is pluggable. Swapping
it in production is a new file, a few environment variables and a deploy; the
auth flow, the OTP store and the clients do not change.

## Where things live

```
src/modules/auth/delivery/
  types.ts              OtpDeliveryProvider, DeliveryError, template helpers
  registry.ts           OTP_DELIVERY_PROVIDER → provider instance
  providers/console.ts  logs the code (development only)
  providers/fake.ts     records codes for tests (development only)
  providers/twilio.ts   Twilio Programmable SMS
  providers/msg91.ts    MSG91 OTP v5
  delivery.test.ts      one describe block per provider
```

`src/modules/auth/otp.ts` is the only caller. It asks the registry for the
provider, calls `sendOtp`, and branches on the typed `DeliveryError.retryable`
flag: `true` becomes a 503 (`DEPENDENCY_UNAVAILABLE`, try again shortly),
`false` becomes a 422 (`OTP_DELIVERY_FAILED`, check the number). The response
to `POST /v1/auth/otp/request` carries the provider's `channel` so the app can
say "code sent by SMS" or "by WhatsApp" without hardcoding either.

## Steps

1. **Implement the provider** in `providers/<name>.ts`:

   ```ts
   export function createAcmeProvider(
     settings: AcmeSettings,
     deps = defaultProviderDeps,
   ): OtpDeliveryProvider {
     return {
       name: 'acme',
       channel: 'sms', // or 'whatsapp' | 'voice'
       async sendOtp(input) {
         // 1. Build the request from `settings` and `renderOtpTemplate(...)`.
         // 2. Call `deps.fetch` with `AbortSignal.timeout(settings.timeoutMs)`.
         // 3. Wrap every failure in DeliveryError with the right `retryable`:
         //    network/timeout/5xx/408/429 → true; any other refusal → false.
         //    `isRetryableHttpStatus` does the HTTP part.
         // 4. Return { provider: 'acme', channel, providerMessageId? }.
       },
     };
   }
   ```

   Take `fetch` through `deps` so the unit test can stub it; never call
   `globalThis.fetch` directly. Never log the code or the full phone number.

2. **Declare its configuration** in `src/config/env.ts`:
   - add `'acme'` to the `OTP_DELIVERY_PROVIDER` enum;
   - add its keys as `optional(...)` entries prefixed `ACME_`;
   - list the required ones in `OTP_PROVIDER_REQUIRED_KEYS.acme` so boot fails
     when the provider is selected but half-configured;
   - document them in `.env.example` (and `tests/fixtures/env.ts` only if a
     key is required in every environment, which it should not be).

3. **Register it** in `registry.ts` — one entry in `FACTORIES` that reads the
   `env.ACME_*` values through `configured(...)`.

4. **Test it** in `delivery.test.ts`: request shape, a terminal 4xx, a
   retryable 5xx, and a network failure. Use `stubFetch` from the same file.

5. **Roll out**: set `OTP_DELIVERY_PROVIDER=acme` and the `ACME_*` variables in
   the target environment. Watch `otp_deliveries_total{provider="acme",result}`
   and the `otp` logger for `OTP delivery failed` after the deploy.

## What not to do

- Do not branch on the vendor name anywhere outside this directory.
- Do not parse vendor error text in `otp.ts`; encode the decision in
  `DeliveryError.retryable` inside the provider.
- Do not add a provider that is not refused in production unless it really
  delivers; `env.ts` lists `console` and `fake` as non-delivering.
