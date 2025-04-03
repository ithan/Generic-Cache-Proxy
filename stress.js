import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics'; // Import Counter

// --- Configuration ---
// Using the hardcoded URL as requested
const BASE_URL = 'http://localhost:3000';

// --- Custom Metrics ---
const stepsApiTiming = new Trend('steps_api_duration');
const otherApiTiming = new Trend('other_api_duration'); // Example
const validationErrors = new Counter('validation_errors');

// Counters for each cache status
const cacheHits = new Counter('cache_status_hit');
const cacheHotHits = new Counter('cache_status_hot_hit');
const cacheMisses = new Counter('cache_status_miss');
const cacheOthers = new Counter('cache_status_other'); // Catch any other statuses or missing header

// --- Test Options ---
export const options = {
    stages: [
        // User's shorter stages
        { duration: '10s', target: 20 },
        // { duration: '20s', target: 180 }, // Target stress VUs
        // { duration: '20s', target: 50 },
        // { duration: '10s', target: 0 },
    ],
    thresholds: {
        'http_req_failed': ['rate<0.01'],
        'http_req_duration': ['p(95)<800'],
        'steps_api_duration': ['p(95)<750'],
        'other_api_duration': ['p(95)<1000'],
        'validation_errors': ['count<10'],

        // Thresholds based on the new counters (examples)
        'cache_status_miss': ['count<50'],     // Allow fewer than 50 absolute misses during the test
        // 'cache_status_miss{api_call:get_steps}': ['rate<0.05'] // Or threshold miss rate for specific API calls
        // 'cache_status_hit': ['rate>0.80'],   // Ensure overall hit rate (HIT + HOT_HIT) is high
    },
    userAgent: 'MyK6StressTest/1.0',
    tags: {
        test_type: 'stress',
        environment: __ENV.ENVIRONMENT || 'local',
    },
};

// --- Test Logic ---
export default function () {
    group('Fetch Steps API', function () {
        const stepsEndpoint = '...'; // Your steps endpoint here
        const res = http.get(`${BASE_URL}${stepsEndpoint}`, {
            tags: { api_call: 'get_steps' }
        });

        stepsApiTiming.add(res.timings.duration);

        // --- Cache Status Counting ---
        const cacheStatus = res.headers['X-Cache-Status'];
        switch (cacheStatus) {
            case 'HIT':
                cacheHits.add(1);
                break;
            case 'HOT_HIT':
                cacheHotHits.add(1);
                break;
            case 'MISS':
                cacheMisses.add(1);
                break;
            default:
                // Catches undefined header or any other unexpected value
                cacheOthers.add(1);
                break;
        }
        // --- End Cache Status Counting ---

        check(res, {
            'Steps: status is 200': (r) => r.status === 200,
            'Steps: response body contains data array': (r) => {
                 // Safer JSON parsing check
                 let jsonData;
                 try {
                     jsonData = r.json();
                     return jsonData && jsonData.data !== undefined && Array.isArray(jsonData.data);
                 } catch (e) {
                     console.error(`Failed to parse JSON for ${r.request.url}: ${e}`);
                     return false;
                 }
            },
            // This check is now somewhat redundant due to the counters, but can be kept if preferred
            'Steps: cache was hit (HIT or HOT_HIT)': (r) => cacheStatus === 'HIT' || cacheStatus === 'HOT_HIT',
        });

        if (res.status === 400) {
            validationErrors.inc(1);
        }

        // sleep(0.5); // Keep sleep commented out as in user's last version
    });

    // Keep other groups commented out as per user's last version
    // group('Fetch Other Proxy Endpoint (Example)', function () { ... });
}