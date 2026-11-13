# Take a card number to Postman

**For:** Support, Developer, Analyst, Administrator.

**Task:** repeat a call in Postman with the real card number.

1. Find the request and open it. Click the step that has the number. In “Step data”, the “Request” row shows the body line with the number. The number is masked.

   ![Request page: a step is selected, the number in the request body is masked](shot:learn-postman-step)

2. In the header click “Show hidden”. The number opens. The button changes to “Hide”.

   ![The same page: the number is open, the button is called “Hide”](shot:learn-postman-open)

3. Click “Copy as cURL”. The command with the open number goes to the clipboard. The button shows a check mark and the word “Copied” for a second.

   ![Step panel, with a number marking the “Copy as cURL” button](shot:learn-postman-curl)

4. In Postman click Import and paste the text. Secrets in the command stay `***`: put in your own access key. Click Send.

   ![Four steps: copy in Threadline, Import in Postman, put in your own key, Send](diagram:learn-postman)

5. Go back to Threadline and click “Hide”. The values are masked again.

   ![Request header, with a number marking the “Hide” button](shot:learn-postman-hide)

## What you should get

The call is repeated in Postman, and everything in Threadline is hidden again.

If you need only the number, select it in the body and copy it the usual way.

If the number still has asterisks, the application hid it before writing it to the log. It cannot be brought back.

Do not paste the number into a ticket or chat. Use a short link for that: everything there is masked.
