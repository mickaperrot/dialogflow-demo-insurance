'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');  
const bodyParser = require('body-parser');
const express = require('express');

const jsforce = require('jsforce');

// Set Firebase variables from the Firebase CLI with: firebase functions:config:set sfdc.url="https://xxx.my.salesforce.com" sfdc.login="perrot@google.com" sfdc.pwd="XXXXX" sfdc.token="XXXXX"

const SFDC_URL = functions.config().sfdc.url;
const SFDC_LOGIN = functions.config().sfdc.login;
const SFDC_PWD = functions.config().sfdc.pwd;
const SFDC_TOKEN = functions.config().sfdc.token;

const SFDC_FIELD_CUSTOMER_ID = 'AccountNumber';
const SFDC_FIELD_ACCOUNT_ID = 'Id';
const SFDC_FIELD_BIRTH_CITY = 'Birth_City__c';
const SFDC_FIELD_BIRTH_DATE = 'Birth_Date__c';
const SFDC_FIELD_WATER_INSURED_PROPERTY_STREET = 'Residence_1_street__c';
const SFDC_FIELD_WATER_INSURED_PROPERTY_CITY = 'Residence_1_city__c';
const SFDC_FIELD_TRANSCRIPT = 'Transcript__c';

// Firestore DB for transcript
admin.initializeApp();
const db = admin.firestore();

const app = express();

class df {
    constructor(options) {
        if (!options.req) {
          throw new Error('Request can NOT be empty.');
        }
        if (!options.res) {
          throw new Error('Response can NOT be empty.');
        }
        this.req_ = options.req;
        this.res_ = options.res;
        this.session = this.req_.body.session;
        this.sessionId = this.session.split('/').pop();
        this.responseId = this.req_.body.responseId;
        this.intent = this.req_.body.queryResult.intent.displayName;
        this.parameters = this.req_.body.queryResult.parameters;
        this.language = this.req_.body.queryResult.languageCode;
        this.outputContexts = this.req_.body.queryResult.outputContexts;
        this.isInteractionEnd = this.req_.body.queryResult.intent.endInteraction;

        this.result = {
            "fulfillmentMessages": [],
            "outputContexts": []
        };

        this.sfdc = new jsforce.Connection({
            loginUrl: SFDC_URL
        });

        this.transcript = {
            "timestamp": Date.now(),
            "customer": [this.req_.body.queryResult.queryText],
            "bot": []
        };

        if(this.req_.body.queryResult.fulfillmentText){
            this.transcript.bot.push(this.req_.body.queryResult.fulfillmentText);
        }

        if(this.isContextSet('followupmessage')){
            console.log('Found a followup message');
            const messageMap = this.getContextParameters('followupmessage');
            this.addMessage(messageMap, false);
        }
    }
    handleRequest(intentMap){
        if (!intentMap) {
            throw new Error('IntentMap can NOT be empty.');
        }
        if(intentMap.get(this.intent)){
            intentMap.get(this.intent)(this);
        }
        else{
            this.res_.status(404).send(`No fulfillment found for intent: ${this.intent}`);
        }
    }
    addMessage(messageMap, addToTranscript = true){
        if(messageMap.has(this.language)){
            // Message available for this language
            this.result.fulfillmentMessages.push({
                "text": {
                    "text": [messageMap.get(this.language)]
                }
            });
            if(addToTranscript){this.transcript.bot.push(messageMap.get(this.language));}
        }
        else{
            // Language not found
            this.res_.status(404).send(`No fulfilment message available for language: ${this.language}`);
        }
    }
    addParameter(context, paramMap, lifespanCount = 5){
        // Adding new context
        let params = {};
        paramMap.forEach((value, key) => {
            params[key] = value;
        });
        this.result.outputContexts.push({
            "name": this.session + `/contexts/${context}`,
            "lifespanCount": lifespanCount,
            "parameters": params
          });
    }
    addContext(context, lifespanCount = 5){
        this.result.outputContexts.push({
            "name": this.session + `/contexts/${context}`,
            "lifespanCount": lifespanCount
          });
    }
    isContextSet(context){
        const contextName = this.session + `/contexts/${context}`;
        const matchingContext = this.outputContexts.find( element => element.name === contextName);
        if(matchingContext){return true;}
        else{return false;}
    }
    getContextParameters(context){
        const parametersMap = new Map();
        const contextName = this.session + `/contexts/${context}`;
        const matchingContext = this.outputContexts.find( element => element.name === contextName);
        if(matchingContext){
            const params = matchingContext.parameters;
            Object.keys(params).forEach( key => {
                if(params[key] !== ''){
                    parametersMap.set(key, params[key]);
                }
            });
            return parametersMap;
        }
        else{
            console.log(`Context ${contextName} is not present`);
            return parametersMap;
            // return null;
        }
    }
    keepContext(){
        // If input context is missing lifespan adding 1 to activate
        let contextKept = this.outputContexts;
        contextKept.forEach((context) => {
            if(!context.lifespanCount){
                context.lifespanCount = 1;
            }
        });
        this.result.outputContexts.push(...this.outputContexts);
    }
    addEvent(event, messageMap){
        // Set event in response
        this.result['followupEventInput'] = 
        {
          "name": event
        };
    }
    removeCustomerMessage(){
        this.transcript.customer = [];
    }
    
    getSfdcTranscript(caseToGetTranscriptFrom){
        return new Promise((resolve, reject) => {
            // If case is null resolve with null string
            if(!caseToGetTranscriptFrom){
                return resolve('');
            }
            this.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN)
            .then(() => {
                console.log('Successfuly logged into SFDC');
                return this.sfdc.sobject("Case").retrieve(caseToGetTranscriptFrom);
            })
            .then((originalCase) => {
                if(originalCase[SFDC_FIELD_TRANSCRIPT]){
                    return resolve(originalCase[SFDC_FIELD_TRANSCRIPT]);
                }
                else{
                    console.error(`Transcript property not available: ${originalCase}`);
                    return resolve('');
                }
            })
            .catch((err) => {
                console.error('Error getting transcript from SFDC', err);
                return resolve('');
            });
        })
    }
    getTranscript(caseToGetTranscriptFrom){
        // Get original case transcript from SFDC
        const sfdcTranscript = this.getSfdcTranscript(caseToGetTranscriptFrom);
        // Get current transcript from firestore
        const firestoreTranscript = new Promise((resolve, reject) => {
            const sessionId = this.session.split('/').pop();
            console.log(`Searching transcript for session: ${sessionId}`);
            db.collection(sessionId).orderBy('timestamp').get()
            .then((snapshot) => {
                console.log(`Successfully found transcript for session: ${sessionId}`);
                let transcript = '';
                snapshot.forEach((doc) => {
                    if(doc.data().customer){
                        doc.data().customer.forEach((phrase) => {
                            transcript = transcript.concat('<p>Customer: ', phrase, '</p>');
                        });
                    }
                    if(doc.data().bot){
                        doc.data().bot.forEach((phrase) => {
                            transcript = transcript.concat('<p>Bot: ', phrase, '</p>');
                        });
                    }
                });
                // Get transcript from last conversation turn
                if(this.transcript){
                    if(this.transcript.customer){
                        this.transcript.customer.forEach((phrase) => {
                            transcript = transcript.concat('<p>Customer: ', phrase, '</p>');
                        });
                    }
                    if(this.transcript.bot){
                        this.transcript.bot.forEach((phrase) => {
                            transcript = transcript.concat('<p>Bot: ', phrase, '</p>');
                        });
                    }
                }
                return resolve(transcript);
            })
            .catch((err) => {
                return reject(err);
            });
        });
        return new Promise((resolve, reject) => {
            Promise.all([sfdcTranscript, firestoreTranscript])
            .then((transcripts) => {
                let now = new Date();
                let transcript;
                // This is a case update
                if(transcripts[0] !== ''){
                    transcript = transcripts[0] + '<p style="text-align: center;"><b><u>---- Update on ' + now.toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: '2-digit'}) + ' ----</u></b></p>' + transcripts[1];
                }
                // This is a new case
                else{
                    transcript = transcripts[1];
                }
                console.log(`Successfully merged transcripts`);
                return resolve(transcript);
            })
            .catch((err) => {
                console.log('Error getting transcript from firestore', err);
                return reject(err);
            });
        })
    }
    send(){
        // If sending event, pass messages as followup context
        if(this.result.followupEventInput && this.result.fulfillmentMessages.length > 0){
            console.log('This is an event, passing added messages as followup');
            const messageMap = new Map();
            this.result.fulfillmentMessages.forEach((message) => {
                messageMap.set(this.language, message.text.text[0]);
            });
            console.log('here', this.result.outputContexts);//
            this.addParameter('followupmessage', messageMap, 1);
        }
        // This is the end of the interaction and claim is available in contexts
        if(this.isInteractionEnd && this.isContextSet('claim')){
            console.log('This is the end of the conversation, uploading transcript');
            const claim = this.getContextParameters('claim');
            // All required parameters are available
            if(claim.has('caseId')){
                const caseId = claim.get('caseId');
                let sfdcCase = {
                    Id: caseId
                };
                let caseToGetTranscriptFrom = null;
                if(this.isContextSet('useexistingcase')){caseToGetTranscriptFrom = caseId;}
                this.getTranscript(caseToGetTranscriptFrom)
                    .then((transcript) => {
                        // Add transcript to the case
                        sfdcCase[SFDC_FIELD_TRANSCRIPT] = transcript;
                        return;
                    })
                    .catch((err) => {
                        console.log('Error getting transcript from Firestore', err);
                        return;
                    })
                    .then(() => {
                        return this.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN);
                    })
                    .then(() => {
                        // Successfully logged to SFDC
                        console.log('Successfully logged into CRM');
                        console.log(`About to update case: ${JSON.stringify(sfdcCase)}`);
                        return this.sfdc.sobject("Case").update(sfdcCase);
                    })
                    .catch(err => {
                        // Error connecting to SFDC
                        return console.error('Error connecting to the CRM', err);
                    })
                    .then(claim => {
                        // Case successfully updated
                        // Update transcript in Firestore
                        db.collection(this.sessionId).doc(this.responseId).set(this.transcript);
                        return console.log(`Successfully uploaded transcript to case: ${JSON.stringify(claim)}`);
                    })
                    .catch(err => {
                        // Error creating the case
                        return console.error('An error occured updating the case', err)
                    });
            }
            // Missing required parameters to upload transcript
            else{
                console.log(`Cannot upload transcript, claim context is missing required parameters: ${JSON.stringify(claim)}`);
            }
        }
        else{
            // Log transcript into Firestore
            db.collection(this.sessionId).doc(this.responseId).set(this.transcript);
        }
        // Return response
        this.res_.json(this.result);
    }
}

const waterClaim = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'I understand that you want to declare a claim following your water damage, is that right?');
    messageMap.set('fr', 'Je comprends que vous voulez déclarer un dégât des eaux, est-ce bien cela ?');
    agent.addMessage(messageMap);
    agent.addContext('waterdamageclaimconfirmation', 1);
    agent.send();
}

const waterClaimConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'Thank you. For verification purposes, can you please tell me your insurance number?');
    messageMap.set('fr', 'Merci. Afin de vérifier votre identité, pouvez-vous m\'indiquer votre numéro d\'assuré ?');
    agent.addMessage(messageMap);
    agent.addContext('waterdamageclaim', 10);
    agent.addContext('customerauthentication', 1);
    agent.send();
}

const waterClaimNotConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'How can I help you?');
    messageMap.set('fr', 'Comment puis-je vous aider ?');
    agent.addMessage(messageMap);
    agent.send();
}

const electricClaim = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'I understand that you want to report the degradation of your electrical installation, is that right?');
    messageMap.set('fr', 'J\'ai compris que vous vouliez reporter un dégât électrique, est-ce bien cela ?');
    agent.addMessage(messageMap);
    agent.addContext('electricdamageclaimconfirmation', 1);
    agent.send();
}

const electricalClaimConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'Thank you. For verification purposes, can you please tell me your insurance number?');
    messageMap.set('fr', 'Merci. Afin de vérifier votre identité, pouvez-vous m\'indiquer votre numéro d\'assuré ?');
    agent.addMessage(messageMap);
    agent.addContext('electricdamageclaim', 10);
    agent.addContext('customerauthentication', 1);
    agent.send();
}

const electricalClaimNotConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'How can I help you?');
    messageMap.set('fr', 'Comment puis-je vous aider ?');
    agent.addMessage(messageMap);
    agent.send();
}

const customerAuthentication = (agent) => {
    // Get customer ID from conversation parameters
    const customerId = agent.parameters.customerId.split(' ').join('');
    console.log(`Customer ID: ${customerId}`);
    // Log into SFDC
    agent.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN)
        .then(() => {
            // Successfully logged in
            console.log('Successfully logged into SFDC');
            // Search Accounts based on customer ID
            const customer = agent.sfdc.sobject("Account")
                .select(`${SFDC_FIELD_ACCOUNT_ID}, ${SFDC_FIELD_BIRTH_CITY}, ${SFDC_FIELD_BIRTH_DATE}, ${SFDC_FIELD_CUSTOMER_ID}, ${SFDC_FIELD_WATER_INSURED_PROPERTY_STREET}, ${SFDC_FIELD_WATER_INSURED_PROPERTY_CITY}`)
                .where(`${SFDC_FIELD_CUSTOMER_ID} = '${customerId.toString()}'`)
                .include("Cases")
                    .select('Id, CreatedDate, Description')
                    .where("Status != 'Closed'")
                    .orderby("CreatedDate", "DESC")
                    .limit(1)
                .execute((err, records) => {
                    // Search error
                    if (err) { return console.error(err); } // To handle as a promise?
                    // Search query success
                    console.log(`Found ${records.length} matching customers`);
                    // At least 1 record found
                    if (records.length > 0){
                        // We take the 1st one even if multiple matching results
                        const customer = records[0];
                        return customer;
                    }
                    // No customer found
                    else{
                        // Customer not found
                        return null;
                    }
                });
                // Return results as a promise and continue then execution
            return customer;
        }).catch(err => {
            console.error(err); // Need to send error message to DF?
        })
        // On account search completion
        .then(customer => {
            // If no customer has been found
            if(!customer){
                const messageMap = new Map();
                messageMap.set('en', `Sorry but we haven't found any record for insurance number ${customerId}. What is your insurance number?`);
                messageMap.set('fr', `Désolé mais nos systèmes ne contiennent aucun enregistrement pour le numéro ${customerId}. Quel est votre numéro d'assuré ?`);
                agent.addMessage(messageMap);
                agent.addContext('customerauthentication', 1);
                agent.send();
                return;
            }
            // There is an existing non closed case for this customer
            if(customer.Cases){
                const existingCase = customer.Cases.records[0];
                console.log(`Found a most recent non-closed case: ${existingCase.Id}`);
                const existingCaseMap = new Map();
                existingCaseMap.set('caseId', existingCase.Id);
                existingCaseMap.set('caseDate', existingCase.CreatedDate);
                existingCaseMap.set('caseDescription', existingCase.Description);
                agent.addParameter('existingcase', existingCaseMap, 10);
            }
            // Pass customer parameters
            const customerMap = new Map();
            customerMap.set('customerId', customer[SFDC_FIELD_ACCOUNT_ID]);
            agent.addParameter('customer', customerMap, 10);
            // Pass parameters for customer verification
            const verificationMap = new Map();
            verificationMap.set('customerBirthDate', customer[SFDC_FIELD_BIRTH_DATE]);
            verificationMap.set('customerBirthCity', customer[SFDC_FIELD_BIRTH_CITY]);
            agent.addParameter('customerverification', verificationMap, 1);
            // Pass insured residence parameters
            const insuredResidenceMap = new Map();
            insuredResidenceMap.set('addressStreet', customer[SFDC_FIELD_WATER_INSURED_PROPERTY_STREET]);
            insuredResidenceMap.set('addressCity', customer[SFDC_FIELD_WATER_INSURED_PROPERTY_CITY]);
            agent.addParameter('insuredresidence', insuredResidenceMap, 10);
            // Ask customer for verification
            const messageMap = new Map();
            messageMap.set('en', 'Thank you! Can yout tell me your date and place of birth?');
            messageMap.set('fr', 'Merci. Quelle est votre dâte et lieu de naissance ?');
            agent.addMessage(messageMap);
            agent.send();
            return;
        }).catch(err => {
            console.error(err); // Need to send error message to DF?
        });
};

const customerVerification = (agent) => {
    // Get parameters for context customerverification
    const parameters = agent.getContextParameters('customerverification');
    // Slot filling incomplete
    if(!parameters.has('verificationBirthDate') || !parameters.has('verificationBirthCity')){
        return agent.send();
    }
    // All required parameters are available
    if(parameters.has('customerBirthDate') && parameters.has('customerBirthCity')){
        const customerBirthDate = new Date(parameters.get('customerBirthDate'));
        const verificationBirthDate = new Date(parameters.get('verificationBirthDate'));
        const customerBirthCity = parameters.get('customerBirthCity').toUpperCase();
        const verificationBirthCity = parameters.get('verificationBirthCity').toUpperCase();
        // Customer verification success
        if(customerBirthCity === verificationBirthCity && customerBirthDate.getDate() === verificationBirthDate.getDate() && customerBirthDate.getMonth() === verificationBirthDate.getMonth() && customerBirthDate.getFullYear() === verificationBirthDate.getFullYear()){
            console.log('Customer successfully verified');
            // No claim context is available
            if(!agent.isContextSet('waterdamageclaim') && !agent.isContextSet('electricdamageclaim')){
                console.log('No water or electric claim context available');
                return agent.send('I am sorry but an error occured, the type of claim is not available.');
            }
            // Water or electric claim
            else{
                // Check if residence parameters are available
                const insuredResidence = agent.getContextParameters('insuredresidence');
                // Missing at least one required parameter
                if(!insuredResidence.has('addressStreet') || !insuredResidence.has('addressCity')){
                    console.log(`Missing insured residence parameters: ${insuredResidence}`);
                    const messageMap = new Map();
                    messageMap.set('en', 'I am sorry but you are not currently covered for this damage.');
                    messageMap.set('fr', 'Je suis désolé mais vous n\'êtes pas couvert pour ce type de dommage.');
                    agent.addMessage(messageMap);
                    return agent.send();
                }
            }

            // Look for existing case
            const existingCase = agent.getContextParameters('existingcase');
            // All case parameters available
            if(existingCase.has('caseDescription') && existingCase.has('caseDate')){
                console.log(`Asking if call is related to case ${existingCase.get('caseId')}`);
                const caseDate = new Date(existingCase.get('caseDate'));
                const formattedCaseDate = caseDate.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'});
                const messageMap = new Map();
                messageMap.set('en', `I found the following open case: ${existingCase.get('caseDescription')}. This case has been opened on ${formattedCaseDate}. Would you like me to update this case with these new details?`);
                messageMap.set('fr', `J'ai trouvé le dossier suivant actuellement ouvert: ${existingCase.get('caseDescription')}. Voulez-vous que je mette à jour ce dossier avec ces nouveaux éléments ?`);
                agent.addMessage(messageMap);
                agent.addContext('followuponexistingcase', 1);
                return agent.send();
            }
            // No existing case found
            else{
                console.log('No existing case found');
                agent.addEvent('DamageAddressVerification');
                return agent.send();
            }
        }
        // Customer verification failure
        else{
            console.log('Customer has not been verified');
            const messageMap = new Map();
            messageMap.set('en', 'I am sorry, the details you provided does not match our records. What is your date and place of birth?');
            messageMap.set('fr', 'Je suis désolé mais les éléments que vous avez fournis ne correspondent pas à nos informations. Quelle est votre dâte et lieu de naissance ?');
            agent.addMessage(messageMap);
            agent.addContext('customerverification', 1);
            return agent.send();
        }
    }
    // Missing CRM parameters
    else{
        console.error(`Cannot proceed with customer verification, found parameters: ${JSON.stringify(parameters)}`);
        const messageMap = new Map();
        messageMap.set('en', 'I am sorry, an error occured while trying to verify your identity.');
        messageMap.set('fr', 'Je suis désolé, une erreur est survenue en tentant de vérifier vôtre identité.');
        agent.addMessage(messageMap);
        return agent.send();
    }
};

const followupConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('fr', 'Très bien.');
    messageMap.set('en', 'Alright.');
    agent.addMessage(messageMap);
    agent.addContext('useexistingcase', 10);
    agent.addEvent('ClaimReady');
    agent.send();
}

const followupNotConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('fr', 'Très bien.');
    messageMap.set('en', 'Alright.');
    agent.addMessage(messageMap);
    agent.addEvent('DamageAddressVerification');
    agent.send();
}

const damageAddressVerification = (agent) => {
    agent.removeCustomerMessage();
    const insuredResidence = agent.getContextParameters('insuredresidence');
    // Insured residence parameters are available
    if(insuredResidence.has('addressStreet') && insuredResidence.has('addressCity')){
        const messageMap = new Map();
        messageMap.set('en', `I am going to create a new case for you. You are currently covered for this damage for your property at ${insuredResidence.get('addressStreet')} in ${insuredResidence.get('addressCity')}. Is that the place where the damage occured?`);
        messageMap.set('fr', `Je vais créer un nouveau dossier pour vous. Vous êtes actuellement couvert pour ce type de dommage pour votre résidence du ${insuredResidence.get('addressStreet')} à ${insuredResidence.get('addressCity')}. S'agit-il du lieu où le dommage est survenu ?`);
        agent.addMessage(messageMap);
        agent.addContext('damageaddressverification', 1);
        return agent.send();
    }
    // Missing insured residence parameters
    else{
        console.log(`Missing insured residence parameters: ${insuredResidence}`);
        const messageMap = new Map();
        messageMap.set('en', 'I am sorry but I am missing details about your residence');
        messageMap.set('fr', 'Je suis désolé mais il manque des détails à propos de vôtre lieu de résidence.');
        agent.addMessage(messageMap);
        return agent.send();
    }
}

const damageAddressConfirmed = (agent) => {
    agent.addEvent('ClaimReady');
    agent.send();
}

const damageAddressNotConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'I am sorry but you are not currently covered for other properties.');
    messageMap.set('fr', 'Je suis désolé mais vous n\'êtes pas couvert pour d\'autres résidences.');
    agent.addMessage(messageMap);
    agent.send();
}

const claimDetailsReady = (agent) => {
    agent.removeCustomerMessage();
    // Need to update an existing case
    if(agent.isContextSet('useexistingcase') && agent.isContextSet('existingcase') && agent.isContextSet('customer')){
        const existingCase = agent.getContextParameters('existingcase');
        const customer = agent.getContextParameters('customer');
        // All parameters are available
        if((existingCase.has('caseId') && existingCase.has('caseDescription') && customer.has('customerId')) && (agent.isContextSet('waterdamageclaim') || agent.isContextSet('electricdamageclaim'))){
            // Update case description in SFDC
            const sfdcCase = {
                Id: existingCase.get('caseId'),
                Description: existingCase.get('caseDescription')
            }
            const now = new Date();
            if(agent.language === 'fr'){
                sfdcCase.Description += `\r\nMise à jour du ${now.getDay()}/${now.getMonth()}/${now.getFullYear()}: `;
            }
            else{
                sfdcCase.Description += `\r\nUpdate on ${now.getDay()}/${now.getMonth()}/${now.getFullYear()}: `;
            }
            // This is a water damage claim
            if(agent.isContextSet('waterdamageclaim')){
                if(agent.language === 'fr'){
                    sfdcCase.Description += `Mise à jour d'un dégât des eaux`;
                }
                else{
                    sfdcCase.Description += 'Water Damage Claim Update';
                }
            }
            // This is an electric damage claim
            else if(agent.isContextSet('electricdamageclaim')){
                if(agent.language === 'fr'){
                    sfdcCase.Description += `Mise à jour d'un dégât électrique`;
                }
                else{
                    sfdcCase.Description += 'Electric Damage Claim Update';
                }
            }
            // Ready to update the case in SFDC
            agent.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN)
                .then(() => {
                    // Successfully logged to SFDC
                    console.log('Successfully logged into CRM');
                    console.log(`About to update case: ${JSON.stringify(sfdcCase)}`);
                    return agent.sfdc.sobject("Case").update(sfdcCase); //
                })
                .then((claim) => {
                    // Successfuly updated case
                    return console.log(`Successfuly updated case: ${claim}`);
                })
                .catch((err) => {
                    return console.log(`Error connecting to SFDC: ${err}`);
                });
            // Pass parameters to claim context
            const claimMap = new Map();
            claimMap.set('customerId', customer.get('customerId'));
            claimMap.set('caseId', existingCase.get('caseId'));
            claimMap.set('caseDescription', existingCase.get('caseDescription'));
            agent.addParameter('claim', claimMap, 10);
            const messageMap = new Map();
            messageMap.set('en', 'If you have not planned yet the intervention, I can send you a list of our licensed professsionals in your area of residence. Do you want me to do that?');
            messageMap.set('fr', 'Si vous n\'avez pas encore planifié d\'intervention, je peux vous envoyer la liste de nos artisans agréés dans votre secteur. Voules-vous que je fasse cela ?');
            agent.addMessage(messageMap);
            agent.addContext('professionalslist', 1);
            agent.send();
            return console.log(`Successfully updated case`);
        }
        // Missing required parameters
        else{
            const messageMap = new Map();
            messageMap.set('en', 'I am sorry but I am missing required parameters from the initial case.');
            messageMap.set('fr', 'Je suis désolé mais des paramètres obligatoires du dossier initial sont manquants.');
            agent.addMessage(messageMap);
            agent.send();
            return console.error('Missing contexts to update existing case');
        }
    }
    // Need to create a new case
    else{
        // Get details from context
        const customer = agent.getContextParameters('customer');
        const insuredResidence = agent.getContextParameters('insuredresidence');
        // All required parameters are available
        if(customer.has('customerId') && insuredResidence.has('addressStreet') && insuredResidence.has('addressCity')){
            let subject;
            // This is a water damage claim
            if(agent.isContextSet('waterdamageclaim')){
                if(agent.language === 'fr'){
                    subject = 'Dégât des eaux';
                }
                else{subject = 'Water Damage Claim';}
            }
            // This is an electric damage claim
            else if(agent.isContextSet('electricdamageclaim')){
                if(agent.language === 'fr'){
                    subject = 'Dégât électrique';
                }
                else{subject = 'Electric Damage Claim';}
            }
            // This is neither a water nor electric claim
            else{
                console.log('Water or electric claim context has not been found');
                const messageMap = new Map();
                messageMap.set('en', 'I am sorry, parameters are missing to create your case');
                messageMap.set('fr', 'Je suis désolé mais il manque des paramètres pour créer votre dossier.');
                agent.addMessage(messageMap);
                return agent.send();
            }
            let desc;
            if(agent.language === 'fr'){
                desc = `${subject} pour la résidence du ${insuredResidence.get('addressStreet')} à ${insuredResidence.get('addressCity')}`;
            }
            else{
                desc = `${subject} for property ${insuredResidence.get('addressStreet')} in ${insuredResidence.get('addressCity')}`;
            }
            const sfdcCase = {
                AccountId: customer.get('customerId'),
                Origin: "Dialogflow",
                Subject: subject,
                Priority: "Medium",
                Description: desc
            };
            agent.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN)
                .then(() => {
                    // Successfully logged to SFDC
                    console.log('Successfully logged into CRM');
                    console.log(`About to create case: ${JSON.stringify(sfdcCase)}`);
                    return agent.sfdc.sobject("Case").create(sfdcCase);
                })
                .catch(err => {
                    // Error connecting to SFDC
                    const messageMap = new Map();
                    messageMap.set('en', 'I am sorry, an error occured connecting to the CRM.');
                    messageMap.set('fr', 'Je suis désolé mais une erreur est survenue lors de la connexion au CRM.');
                    agent.addMessage(messageMap);
                    agent.send();
                    return console.error(err); // Need to send error message to DF?
                })
                .then(claim => {
                    // Case successfully created
                    // Pass parameters to context
                    const claimMap = new Map();
                    claimMap.set('customerId', customer.get('customerId'));
                    claimMap.set('caseId', claim.id);
                    agent.addParameter('claim', claimMap, 10);
                    agent.addEvent('ClaimCreated');
                    agent.send();
                    return console.log(`Successfully created case: ${JSON.stringify(claim)}`);
                })
                .catch(err => {
                    // Error creating the case
                    const messageMap = new Map();
                    messageMap.set('en', 'I am sorry, an error occured creating your case.');
                    messageMap.set('fr', 'Je suis désolé, une erreur est survenue lors de la création de votre dossier.');
                    agent.addMessage(messageMap);
                    agent.send();
                    return console.error(err);
                });
        }
        // Missing at least one required parameter to create the case
        else{
            console.log(`Missing Parameters:\nCustomer parameters: ${Array.from(customer)}\nWaterInsuredProperty parameters: ${Array.from(insuredResidence)}`);
            const messageMap = new Map();
            messageMap.set('en', 'I am sorry, an error occured creating your case.');
            messageMap.set('fr', 'Je suis désolé, une erreur est survenue lors de la création de votre dossier.');
            agent.addMessage(messageMap);
            agent.send();
        }
    }
}

const claimCreated = (agent) => {
    agent.removeCustomerMessage();
    const messageMap = new Map();
    messageMap.set('en', 'Thank you. I will connect you with one of our advisors. If you have taken photos of the damage please get them ready, they will be useful to us to complete your file. You will receive a text message on your phone in a few moments with a link to upload them to your file.');        
    messageMap.set('fr', 'Merci. Je vais vous mettre en relation avec un de nos conseillers. Si vous avez pris des photos du dégât, tenez les prêtes, elles seront utiles pour compléter votre dossier. Vous recevrez dans quelques instants un SMS avec un lien permettant de télécharger ces photos dans votre dossier.');
    agent.addMessage(messageMap);
    agent.send();
}

const listConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', 'You will receive a link to the list via SMS in a few minutes.');        
    messageMap.set('fr', 'Vous allez recevoir dans quelques minutes la liste par SMS.');
    agent.addMessage(messageMap);
    // Pass parameters to Genesys
    const listMap = new Map();
    listMap.set('sendlist', true);
    agent.addParameter('sendlist', listMap, 10);
    wrapConversation(agent);
}

const listNotConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', `Copy that.`);
    messageMap.set('fr', `C'est noté.`);
    agent.addMessage(messageMap);
    // Pass parameters to Genesys
    const listMap = new Map();
    listMap.set('sendlist', false);
    agent.addParameter('sendlist', listMap, 10);
    wrapConversation(agent);
}

const callbackConfirmed = (agent) => {
    const messageMap = new Map();
    messageMap.set('en', `What date and time would you like me to schedule the call?`);        
    messageMap.set('fr', `A quelle date et heure voulez-vous que je planifie l'appel ?`);
    agent.addMessage(messageMap);
    agent.addContext('getcallbackparameters', 1);
    agent.send();
}

const callbackParameters = (agent) => {
    try {
        const childMap = agent.getContextParameters('child');
        if(!childMap.has('phone')){
            throw new Error('Missing phone number in context');
        }
        const callback = new Date(Date.parse(agent.parameters.date.split('T')[0] + 'T' + agent.parameters.time.split('T')[1]));
        const callbackMap = new Map();
        callbackMap.set('datetime', callback);
        if(childMap.has('firstName') && childMap.has('lastName')){
            callbackMap.set('name', `${childMap.get('firstName')} ${childMap.get('lastName')}`);
        }
        callbackMap.set('number', childMap.get('phone'));
        // Create SFDC opportunity
        return createOpportunity(agent, childMap, callbackMap)
            .then((opportunity) => {
                console.log('resolved oppy', opportunity);
                callbackMap.set('opportunity', opportunity);
                return;
            })
            .catch((err) => {
                console.log('Opportunity not created');
                throw err;
            })
            .finally(() => {
                const messageMap = new Map();
                messageMap.set('en', `Thank you. We will call back ${childMap.get('firstName')}.`); 
                messageMap.set('fr', `Merci. Nous rappelerons ${childMap.get('firstName')}.`);
                agent.addMessage(messageMap);
                agent.addParameter('callback', callbackMap, 10);
                agent.addEvent('AddAnything');
                agent.send();
                return
            });
        //agent.addContext('getcallbackparameters', 1); //---- if outside working hours
    } catch (error) {
        console.error('Error in creating callback' ,error);
        agent.send();
    }
}

const callbackNotConfirmed = (agent) => {
    agent.addEvent('AddAnything');
    agent.send();
}

const addAnything = (agent) => {
    agent.removeCustomerMessage();
    const messageMap = new Map();
    messageMap.set('en', 'Is there anything else you would like to mention?');
    messageMap.set('fr', 'Voulez-vous mentionner autre chose ?');
    agent.addMessage(messageMap);
    agent.addContext('addanythingconfirmation', 1);
    agent.send();
}

const addAnythingConfirmed = (agent) => {
    agent.send();
}

const addAnythingNotConfirmed = (agent) => {
    agent.send();
}

const waterClaimFallback = (agent) => {
    // Keep contexts
    agent.keepContext();
    const messageMap = new Map();
    messageMap.set('en', 'I am sorry but I do not understand. Would you like to declare a claim for water damage?');        
    messageMap.set('fr', `Je suis désolée, je n'ai pas compris. Souhaitez-vous déclarer un dégât des eaux ?`);
    agent.addMessage(messageMap);
    agent.send();
}

const electricalClaimFallback = (agent) => {
    // Keep contexts
    agent.keepContext();
    const messageMap = new Map();
    messageMap.set('en', 'I am sorry but I do not understand. Would you like to declare a claim for electric damage?');        
    messageMap.set('fr', `Je suis désolée, je n'ai pas compris. Souhaitez-vous déclarer un dégât électrique ?`);
    agent.addMessage(messageMap);
    agent.send();
}

const fallback = (agent) => {
    // Keep contexts
    agent.keepContext();
    const messageMap = new Map();
    messageMap.set('en', 'I am sorry but I do not understand.');        
    messageMap.set('fr', 'Je suis désolé, je ne comprends pas.');
    agent.addMessage(messageMap);
    agent.send();
}

const wrapConversation = (agent) => {
    // Check if one child is close to 18y
    const customer = agent.getContextParameters('customer');
    const customerId = customer.get('customerId');
    agent.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN)
        .then(()=>{
            // Logged into SFDC
            console.log('Successfully logged into SFDC');
            // Search for contacts turning 18y in < 6m
            const dateStart = new Date();
            dateStart.setFullYear(dateStart.getFullYear()-18);
            const dateEnd = new Date(dateStart);
            dateEnd.setMonth(dateStart.getMonth()+6);
            return agent.sfdc.sobject("Contact")
                .select("Id, LastName, FirstName, Birthdate, Phone, MobilePhone, HomePhone, OtherPhone")
                .where(`AccountId = '${customerId}' AND Birthdate > ${dateStart.toISOString().split('T')[0]} AND Birthdate < ${dateEnd.toISOString().split('T')[0]}`)
                .execute(function(err, records) {
                    if(err){
                        console.error('Error in SFDC request');
                        throw err;
                    }
                    else{
                        console.log("Fetched SFDC records: " + records.length);
                        return records[0];
                    }
                });
        })
        .then((child) => {
            if(!child){
                throw new Error('No child record found');
            }
            // All child parameters available
            const childMap = new Map();
            childMap.set('id', child.Id);
            childMap.set('firstName', child.FirstName);
            childMap.set('lastName', child.LastName);
            if(child.MobilePhone){
                childMap.set('phone', child.MobilePhone);
            }
            else if(child.HomePhone){
                childMap.set('phone', child.HomePhone);
            }
            else if(child.Phone){
                childMap.set('phone', child.Phone);
            }
            else if(child.OtherPhone){
                childMap.set('phone', child.OtherPhone);
            }
            agent.addParameter('child', childMap, 10);
            const messageMap = new Map();
            messageMap.set('en', `It seems like ${childMap.get('firstName')} ${childMap.get('lastName')} will reach 18 soon and won't be covered anymore by your family liability contract. Would you like me to schedule a call with ${childMap.get('firstName')} to discuss our options?`);        
            messageMap.set('fr', `Il semblerait que ${childMap.get('firstName')} ${childMap.get('lastName')} ait bientôt 18 ans et ne bénéficera plus de la couverture civile de votre contrat. Voulez-vous que je planifie un appel avec ${childMap.get('firstName')} pour lui présenter nos différentes options ?`);
            agent.addMessage(messageMap);
            agent.addContext('callbackconfirmation', 1);
            return agent.send();
        })
        .catch((err)=>{
            console.error(err);
            agent.addEvent('AddAnything');
            agent.send();
        });
}

const createOpportunity = (agent, childMap, callbackMap) => {
    return new Promise((resolve, reject) => {
        // Create opportunity object
        let opportunity;
        try {
            const customerMap = agent.getContextParameters('customer');
            const accountId = customerMap.get('customerId');
            const callbackDateTime = callbackMap.get('datetime').toISOString();
            const callbackDate = callbackDateTime.split('T')[0];
            const callbackTime = callbackDateTime.split('T')[1].split(':')[0] + ':' + callbackDateTime.split('T')[1].split(':')[1];
            opportunity = {
                "AccountId": accountId,
                "Name": "Personnal Liability Lead",
                "Description": null,
                "StageName": "Prospecting",
                "CloseDate": callbackDate,
                "Type": "New Customer",
                "NextStep": "Callback on " + callbackDate + " at " + callbackTime,
                "LeadSource": "Phone Inquiry"
            };
        } catch (error) {
            console.log('Cannot create opportunity object, skipping SFDC upload');
            reject(error);
        }
        // Create opportunity in SFDC
        let opportunityId;
        agent.sfdc.login(SFDC_LOGIN, SFDC_PWD + SFDC_TOKEN)
            .then(() => {
                console.log('Successfuly logged into CRM');
                return agent.sfdc.sobject("Opportunity").create(opportunity);
            })
            .then((record) => {
                if(!record.id){
                    throw new Error('Opportunity not created');
                }
                opportunityId = record.id;
                console.log(`Successfuly created opportunity: ${opportunityId}`);
                // Create opportunity contact role
                const contactId = childMap.get('id');
                const opportunityContact = {
                    "OpportunityId": opportunityId,
                    "ContactId": contactId,
                    "Role": "Decision Maker",
                    "IsPrimary": true
                };
                return agent.sfdc.sobject("OpportunityContactRole").create(opportunityContact);
            })
            .then((record) => {
                console.log(`Successfuly created opportunity contact role: ${record.id}`);
                return resolve(opportunityId);
            })
            .catch((err) => {
                console.log('Error creating opportunity in SFDC');
                return reject(err);
            });
    });
}

app.use(bodyParser.json());

app.post('/', (req, res) => {
    const agent = new df({req, res});
    console.log(`Intent: ${agent.intent}`);
    const intentMap = new Map();
    intentMap.set('Water Damage Claim', waterClaim);
    intentMap.set('Water Damage Claim - Confirmed', waterClaimConfirmed);
    intentMap.set('Water Damage Claim - Not Confirmed', waterClaimNotConfirmed);
    intentMap.set('Water Damage Claim - Fallback', waterClaimFallback);
    intentMap.set('Customer Authentication', customerAuthentication);
    intentMap.set('Customer Verification', customerVerification);
    intentMap.set('Electric Damage Claim', electricClaim);
    intentMap.set('Electric Damage Claim - Confirmed', electricalClaimConfirmed);
    intentMap.set('Electric Damage Claim - Not Confirmed', electricalClaimNotConfirmed);
    intentMap.set('Electric Damage Claim - Fallback', electricalClaimFallback);
    intentMap.set('Followup On Existing Case - Confirmed', followupConfirmed);
    intentMap.set('Followup On Existing Case - Not Confirmed', followupNotConfirmed);
    intentMap.set('Damage Address Verification', damageAddressVerification);
    intentMap.set('Damage Address Verification - Confirmed', damageAddressConfirmed);
    intentMap.set('Damage Address Verification - Not Confirmed', damageAddressNotConfirmed);
    intentMap.set('Claim Ready', claimDetailsReady);
    intentMap.set('Claim Created', claimCreated);
    intentMap.set('Professionals List - Confirmed', listConfirmed);
    intentMap.set('Professionals List - Not Confirmed', listNotConfirmed);
    intentMap.set('Child Callback - Confirmed', callbackConfirmed);
    intentMap.set('Child Callback - Not Confirmed', callbackNotConfirmed);
    intentMap.set('Child Callback - Confirmed - Datetime', callbackParameters);
    intentMap.set('Claim Updated - Anything To Add', addAnything);
    intentMap.set('Claim Updated - Anything To Add - Confirmed', addAnythingConfirmed);
    intentMap.set('Claim Updated - Anything To Add - Not Confirmed', addAnythingNotConfirmed);
    intentMap.set('Default Fallback Intent', fallback);
    agent.handleRequest(intentMap);
});

exports.dialogflowFulfillment = functions
    .region('europe-west2')
    .https.onRequest(app);