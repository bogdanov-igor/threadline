# First project file, short version

**For:** Developer, Analyst, Administrator.

**Task:** describe one system and one of its errors through the file. The project already exists.

1. Click the project name in the header, then “Catalog”, then “Project file”. The whole project opens as one text.

   ![The “Project file” page: text with line numbers, “Download”, “Upload file”](shot:learn-file-open)

2. Select all the text and paste this instead. Put in your own project and host. Records that are not in the text stay in the project.

   ```yaml
   version: 1
   project: pay
   systems:
     - key: fraud
       name: Fraud check
       hosts:
         - fraud.pay.example:9090
       errors:
         - http: 500
           title: The check could not process the request
           action: Try again later. If it keeps happening, contact the fraud check support.
   ```

3. Wait a couple of seconds. Threadline checks the text and says what will be added. An error in the text is marked next to its line. Click “Apply 2 changes”.

   ![Check report: two records will be added, “Apply 2 changes” button](shot:learn-file-typed)

4. Threadline confirms the write and shows the fresh project text.

   ![The message “File imported: 2 records changed”](shot:learn-file-applied)

5. Open a request with this system. It now shows the system name and your error text.

   ![Request page: the “Fraud check” system, the error text and “What to do”](shot:learn-file-result)

## What you should get

The system name is visible in place of the address, and your sentence in place of HTTP 500. You do not need to read the logs again.

If there is no “Apply” button, the text has an error or there is nothing to change. If you are Support, the file is open for reading only.

More details: [Project file](/docs/file-start).
