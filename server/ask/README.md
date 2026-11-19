# ProScan Ask server

One AWS Lambda (`proscan-ask`, us-east-1, Node 22) behind a function URL. Signed-in users without their own Gemini key ask through it.

- Checks the Firebase ID token (project `proscanbot`) on every request.
- 20 questions per user per day and 2,000 for the whole service, counted in the DynamoDB table `proscan-ask-usage` (rows expire after two days).
- The Gemini key is the SSM SecureString `/proscan/ask/gemini-key`, a key made only for this in the AI Studio project whose monthly spend cap bounds the cost.
- It builds the prompt with `scripts/lib/chat.js`, the same code the extension uses, and re-cleans every field the client sends.

Deploy with `sh server/ask/deploy.sh`. The function's role is `app/proscan-ask-role`.
