import * as http from 'http';
import * as https from 'https';

// Extend the global fetch RequestInit interface to include Node.js specific options
declare global {
  interface RequestInit {
    agent?: http.Agent | https.Agent;
  }
}

// Add an empty export to make this a module
export {};