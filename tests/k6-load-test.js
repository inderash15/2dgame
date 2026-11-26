import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

export const options = {
  scenarios: {
    normal_load:       { executor: 'constant-vus', vus: 50,  duration: '2m',  startTime: '0m' },
    expected_load:     { executor: 'constant-vus', vus: 100, duration: '5m',  startTime: '2m' },
    full_capacity:     { executor: 'constant-vus', vus: 279, duration: '10m', startTime: '7m' },
    stress_test:       { executor: 'constant-vus', vus: 350, duration: '10m', startTime: '17m' },
    high_stress:       { executor: 'constant-vus', vus: 450, duration: '5m',  startTime: '27m' },
    extreme_stress:    { executor: 'constant-vus', vus: 550, duration: '5m',  startTime: '32m' },
    spike_test: {
      executor: 'ramping-vus',
      startTime: '37m',
      stages: [
        { duration: '30s', target: 20 },
        { duration: '15s', target: 279 },
        { duration: '2m',  target: 279 },
        { duration: '30s', target: 20 }
      ]
    },
    endurance_test:    { executor: 'constant-vus', vus: 279, duration: '30m', startTime: '40m30s' }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500']
  }
};

export default function () {
  const num = String((__VU % 263) + 1).padStart(3, '0');
  const res1 = http.get(`${BASE_URL}/api/portal/team/T${num}`);
  check(res1, { 'team lookup 200 or 429': (r) => r.status === 200 || r.status === 429 });

  const res2 = http.get(`${BASE_URL}/api/games?page=${(__VU % 10) + 1}&limit=25`);
  check(res2, { 'catalog page 200 or 429': (r) => r.status === 200 || r.status === 429 });
  sleep(1);
}
