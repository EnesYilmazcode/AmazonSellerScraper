# ProScan Ask server

One AWS Lambda (`proscan-ask`, us-east-1, Node 22) behind a function URL. Signed-in users without their own Gemini key ask through it.

- Checks the Firebase ID token (project `proscanbot`) on every request.
- 20 questions per user per day and 2,000 for the whole service, counted in the DynamoDB table `proscan-ask-usage` (rows expire after two days).
- Answers come only from Amazon Bedrock (Claude Haiku 4.5 by default, `BEDROCK_MODEL`), paid by the AWS credits. No outside AI key is involved.
- It builds the prompt with `scripts/lib/chat.js`, the same code the extension uses, and re-cleans every field the client sends.

Deploy with `sh server/ask/deploy.sh`. The function's role is `app/proscan-ask-role`.
