# DialogFlow SFDC Integration Example

This is an example integration of **Google Dialogflow ES** with **SalesForce**.
## Introduction

This example includes three parts:

- A [Dialogflow ES](https://cloud.google.com/dialogflow/es/docs) agent which is the bot communicating with the human
- A [Google Cloud Function using the Firebase SDK](https://firebase.google.com/docs/functions) used for fulfilling the requests
- A Salesforce instance, for example the [Salesforce Developper Edition](https://developer.salesforce.com/signup)
## Retreive Salesforce details

You need the following details from your Salesforce environment for the next step:

- The environment URL, for example: `https://xxx.my.salesforce.com`
- A user login
- A user password
- An associated Salesforce token

You also need some specific fields to be available (you can use custom fields).

Edit the following variables in `functions/index.js` and set your specific Salesforce fields:

- Account:
    - *SFDC_FIELD_ACCOUNT_ID*: Account object ID
    - *SFDC_FIELD_CUSTOMER_ID*: 6-digit customer ID used for customer authentication (Text Data Type)
    - *SFDC_FIELD_BIRTH_CITY*: customer birth city (Text Data Type) used for customer verification
    - *SFDC_FIELD_BIRTH_DATE*: customer birth date (Date Data Type) used for customer verification
    - *SFDC_FIELD_WATER_INSURED_PROPERTY_STREET*: customer insured property street address (Text Area Data Type)
    - *SFDC_FIELD_WATER_INSURED_PROPERTY_CITY*: customer insured property city address (Text Area Data Type)
- Case:
    - *SFDC_FIELD_TRANSCRIPT*: field for storing the conversation transcript (Rich Text Area Data Type)
## Set up the Google Cloud Function

1. Clone this repo.
1. Run `npm install` in the `functions` directory.
1. Create a Firebase project in the
   [Firebase Console](https://console.firebase.google.com)
1. Create a [Firestore Database](https://firebase.google.com/docs/firestore/quickstart) for storing the conversation transcripts
1. [Set up or update the Firebase CLI](https://firebase.google.com/docs/cli#setup_update_cli)
1. Set the Firebase project: `firebase use --add YOUR_FIREBASE_PROJECT`
1. Configure the Salesforce details as Firebase variables: `firebase functions:config:set sfdc.url="https://xxx.my.salesforce.com" sfdc.login="perrot@google.com" sfdc.pwd="XXXXX" sfdc.token="XXXXX"`
    - *sfdc.url*: your SalesForce environment URL
    - *sfdc.login*: your SalesForce login
    - *sfdc.pwd*: your SaleForce password
    - *sfdc.token*: the associated token
1. Deploy the Google Cloud Function using `firebase deploy --only functions`
1. Keep the endpoint URL for the next step
## Set up the dialogflow agent

Follow [the documentation](https://cloud.google.com/dialogflow/es/docs/quick/setup) to set up a Google Cloud Project for your agent.

Create a new agent and import `AgentExport.zip`.

Enable [Webhook fulfillment](https://cloud.google.com/dialogflow/es/docs/fulfillment-webhook#enable) and set the URL to your Google Cloud Function.