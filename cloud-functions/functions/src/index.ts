import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as _gcs from '@google-cloud/storage';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const Vision = require('@google-cloud/vision');
const _spawn = require('child-process-promise');


const spawn = _spawn.spawn;
const gcs = _gcs();
const vision = new Vision();
admin.initializeApp();

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });


/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Import the Firebase SDK for Google Cloud Functions.
//const functions = require('firebase-functions');
// Import and initialize the Firebase Admin SDK.



// Adds a message that welcomes new users into the chat.
export const addWelcomeMessages = functions.auth.user().onCreate(user => {
  console.log('A new user signed in for the first time.');
  const fullName = user.displayName || 'Anonymous';

  // Saves the new welcome message into the database
  // which then displays it in the FriendlyChat clients.
  return admin.database().ref('messages').push({
    name: 'Firebase Bot',
    photoUrl: '/images/firebase-logo.png', // Firebase logo
    text: `${fullName} signed in for the first time! Welcome!`,
  }).then(() => {
    console.log('Welcome message written to database.');
    return null;
  });
});

// Checks if uploaded images are flagged as Adult or Violence and if so blurs them.
export const blurOffensiveImages = functions.storage.object().onFinalize(object => {
  const image = {
    source: {imageUri: `gs://${object.bucket}/${object.name}`},
  };

  // Check the image content using the Cloud Vision API.
  return vision.safeSearchDetection(image).then((batchAnnotateImagesResponse: any[]) => {
    const safeSearchResult = batchAnnotateImagesResponse[0].safeSearchAnnotation;
    const Likelihood = Vision.types.Likelihood;
    if (Likelihood[safeSearchResult.adult] >= Likelihood.LIKELY ||
        Likelihood[safeSearchResult.violence] >= Likelihood.LIKELY) {
      console.log('The image', object.name, 'has been detected as inappropriate.');
      if (!object.name) {
        console.log('Object has no name');
        return null;
      }
      return blurImage(object.name, object.bucket);
    }
    console.log('The image', object.name, 'has been detected as OK.');
    return null;
  });
});

// Blurs the given image located in the given bucket using ImageMagick.
function blurImage(filePath: string, bucketName: string) {
  const tempLocalFile = path.join(os.tmpdir(), path.basename(filePath));
  const messageId = filePath.split(path.sep)[1];
  const bucket = gcs.bucket(bucketName);

  // Download file from bucket.
  return bucket.file(filePath).download({destination: tempLocalFile}).then(() => {
    console.log('Image has been downloaded to', tempLocalFile);
    // Blur the image using ImageMagick.
    return spawn('convert', [tempLocalFile, '-channel', 'RGBA', '-blur', '0x24', tempLocalFile]);
  }).then(() => {
    console.log('Image has been blurred');
    // Uploading the Blurred image back into the bucket.
    return bucket.upload(tempLocalFile, {destination: filePath});
  }).then(() => {
    console.log('Blurred image has been uploaded to', filePath);
    // Deleting the local file to free up disk space.
    fs.unlinkSync(tempLocalFile);
    console.log('Deleted local file.');
    // Indicate that the message has been moderated.
    return admin.database().ref(`/messages/${messageId}`).update({moderated: true});
  }).then(() => {
    console.log('Marked the image as moderated in the database.');
    return null;
  });
}

// Sends a notifications to all users when a new message is posted.
export const sendNotifications = functions.database.ref('/messages/{messageId}').onCreate(snapshot => {
  // Notification details.
  const text = snapshot.val().text;
  const payload = {
    notification: {
      title: `${snapshot.val().name} posted ${text ? 'a message' : 'an image'}`,
      body: text ? (text.length <= 100 ? text : text.substring(0, 97) + '...') : '',
      icon: snapshot.val().photoUrl || '/images/profile_placeholder.png',
      click_action: `https://${process.env.GCLOUD_PROJECT}.firebaseapp.com`,
    }
  };

  let tokens :any[] = []; // All Device tokens to send a notification to.
  // Get the list of device tokens.
  return admin.database().ref('fcmTokens').once('value').then(allTokens => {
    if (allTokens.val()) {
      // Listing all tokens.
      tokens = Object.keys(allTokens.val());

      // Send notifications to all tokens.
      return admin.messaging().sendToDevice(tokens, payload);
    }

    return Promise.resolve({results: []});
  }).then(response => {
    // For each notification we check if there was an error.
    const tokensToRemove : { [key:string]:string; }= {ignore:''};
    response.results.forEach((result, index) => {
      const error = result.error;
      if (error) {
        console.error('Failure sending notification to', tokens[index], error);
        // Cleanup the tokens who are not registered anymore.
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
          tokensToRemove[`/fcmTokens/${tokens[index]}`] = null;
        }
      }
    });
    return admin.database().ref().update(tokensToRemove);
  }).then(() => {
    console.log('Notifications have been sent and tokens cleaned up.');
    return null;
  });
});
