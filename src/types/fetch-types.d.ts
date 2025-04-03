import * as http from 'http';
import * as https from 'https';

// Extend the RequestInit interface to include the Node.js specific 'agent' property
declare global {
  interface RequestInit {
    agent?: http.Agent | https.Agent;
  }
}
