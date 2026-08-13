# Security

## Reporting a vulnerability

Email **corrections@commissionwatch.bmux.sh** with `SECURITY` in the subject. Please do not open
a public issue for anything that would expose reader data or let someone publish under the
project's name.

Tell us what you did, what you saw, and what you expected. A request line and a response is worth
more than a description. We will acknowledge within 72 hours and tell you what we intend to do,
including if the answer is "this is working as designed, and here is why."

This is a volunteer watchdog project with no bounty programme. What we can offer is credit in the
fix commit if you want it, and an honest timeline if you do not.

## What we consider a vulnerability

The project publishes claims about named public officials, so its threat model is not only the
usual one. All of these are in scope:

- **Reader PII.** Subscriber email addresses and phone numbers are the only personal data the
  project holds about people who did not choose to be public. Any path that lists, enumerates or
  correlates them without an operator session is a vulnerability, and was the finding that
  motivated this file.
- **Publishing without review.** Anything that lets generated text naming a person reach the
  public site without passing the operator review queue. A bypass here is as serious as a
  credential leak: the project's only real asset is that nothing it published was unreviewed.
- **Forging the record.** Anything that lets a claim be attributed to a stored artifact that does
  not support it, or that lets a stored artifact be altered while keeping its content address.
- **Operator session compromise.** The admin surface has no registration route by design; the
  first operator is seeded from Parameter Store. Anything that mints, extends, fixes or steals a
  session belongs here.
- **SSRF via delivery channels.** Webhook URLs are operator-supplied and fetched by the server.
  `assertPublicWebhookUrl` rejects loopback, private, link-local and cloud-metadata addresses
  after DNS resolution; a bypass is in scope.
- **Denial of collection.** Anything that makes the ingestion queue stop collecting silently.
  A transparency project that quietly stops watching is failing at the only thing it does.

## What is not a vulnerability

- **The public read API is unauthenticated and open to any origin.** That is the product. The bulk
  export at `/api/data` is deliberately keyless.
- **Published findings name officials.** Every one of them was approved by a named human and
  traces to a stored document. If a published claim is *wrong*, that is a correction, not a
  security report — use the corrections form, which is a better path and a faster one.
- **Infrastructure identifiers in `deploy/`.** The AWS account id, the instance id and the ECR
  registry host are written down on purpose so the deploy path is reproducible by a reader. They
  are identifiers, not credentials, and every action against them requires an IAM principal we
  control. Report a *credential*, not a name.
- **Scraped fixtures under `backend/test/fixtures/`.** These are verbatim copies of pages the
  source governments serve publicly. Anything embedded in them was already public on the source's
  own site. We redact keys we notice anyway; tell us about ones we missed.

## Secrets

No secret is ever committed, and none is ever put in an SSM `send-command` payload — those
parameters are retained in plaintext for 30 days and land in CloudTrail. Secrets live in AWS
Parameter Store under `/commissionwatch/`, are fetched by the host, and reach the containers as
an env file the host writes. `backend/.env.example` is the checklist of every variable the code
reads and holds no values.

If you believe a secret was committed at any point in this repository's history, report it as a
vulnerability rather than opening an issue, and we will rotate first and investigate second.
