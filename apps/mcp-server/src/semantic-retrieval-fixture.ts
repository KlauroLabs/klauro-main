import * as os from 'node:os';
import * as path from 'node:path';

export interface RetrievalFixtureEntry {
  repoPath: string;
  query: string;
  expectedNodeIds: string[];
}

const benchmarkDevRoot = path.resolve(process.env.KLAURO_BENCH_DEV_ROOT || path.join(os.homedir(), 'dev'));
const CLIENT_UI = path.join(benchmarkDevRoot, 'zerac', 'client-ui');
const ADMIN_PORTAL_UI = path.join(benchmarkDevRoot, 'clients', 'yisda', 'admin-portal-ui');

export const RETRIEVAL_FIXTURE: RetrievalFixtureEntry[] = [
  {
    repoPath: CLIENT_UI,
    query: 'trust a self-signed certificate on a mac',
    expectedNodeIds: ['function_local-https.ts_trustCertificateMac_3'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'create the root certificate authority',
    expectedNodeIds: ['function_local-https.ts_generateRootCA_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'add an entry to the operating system hosts file',
    expectedNodeIds: ['function_local-https.ts_addToHostsFile_2'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'the screen where a user signs in',
    expectedNodeIds: ['function_src/app/Login.tsx_LoginPage_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'sign the user out of the application',
    expectedNodeIds: ['function_src/app/Logout.tsx_Logout_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'pick a consistent color for a given value',
    expectedNodeIds: ['function_src/shared/utils/get-deterministic-color.ts_getDeterministicColor_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'format a timestamp for display',
    expectedNodeIds: [
      'function_src/shared/utils/helpers.ts_getTimeFormatted_1',
      'function_src/shared/utils/helpers.ts_getDateFormatted_2',
    ],
  },
  {
    repoPath: CLIENT_UI,
    query: 'derive a person initials from their name',
    expectedNodeIds: ['function_src/shared/utils/get-initials.ts_getInitials_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'chart that plots monitoring metrics over time',
    expectedNodeIds: ['function_src/shared/components/MonitoringGraph.tsx_MonitoringGraph_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'widget that shows whether the firewall is on',
    expectedNodeIds: ['function_src/shared/components/FirewallStatus.tsx_FirewallStatus_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'where authentication tokens are kept and refreshed',
    expectedNodeIds: ['class_src/shared/auth/token-manager.ts_TokenManager_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'read back the current auth token',
    expectedNodeIds: ['method_class_src/shared/auth/token-manager.ts_TokenManager_0_getToken_1'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'determine if this device has been seen before',
    expectedNodeIds: ['function_src/app/DeviceAuth.tsx_checkDeviceRecognition_1'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'popup dialog that surfaces notifications to the user',
    expectedNodeIds: ['function_src/shared/components/NotificationModal.tsx_NotificationModal_0'],
  },
  {
    repoPath: CLIENT_UI,
    query: 'generate a random whole number',
    expectedNodeIds: ['function_src/shared/generators/index.ts_randomInt_0'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'shorten a long string and append an ellipsis',
    expectedNodeIds: ['function_src/utils/index.ts_truncateString_2'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'render a date as month day year',
    expectedNodeIds: ['function_src/utils/index.ts_DateFormatMDY_0'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'send an HTTP request that uploads a file',
    expectedNodeIds: ['function_src/utils/http.ts_postWithFile_1'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'obtain the okta access token',
    expectedNodeIds: ['function_src/utils/oktaToken.ts_getAccessToken_0'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'insert a new user into application state',
    expectedNodeIds: ['function_src/stores/users.ts_addUser_2'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'wait until the user stops typing before running a function',
    expectedNodeIds: ['function_src/hooks/useDebounceFunc.tsx_useDebounceFunc_0'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'drop a gateway from the store',
    expectedNodeIds: ['function_src/stores/gateways.ts_removeGateway_7'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'convert a status code into a readable label',
    expectedNodeIds: ['function_src/utils/displayStatus.ts_displayStatus_0'],
  },
  {
    repoPath: ADMIN_PORTAL_UI,
    query: 'fetch the list of connected gateways from the backend',
    expectedNodeIds: ['function_src/hooks/useConnectedAPI.tsx_useConnectedGatewayList_0'],
  },
];
