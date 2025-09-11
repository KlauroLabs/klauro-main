"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const app_1 = require("./app");
const logger_service_1 = require("./services/logger.service");
const PORT = parseInt(process.env.PORT || '3001');
const logger = new logger_service_1.Logger('Main');
async function startServer() {
    try {
        logger.info('Initializing Unravl Platform...');
        const app = new app_1.App();
        await app.initialize();
        app.start(PORT);
        logger.info('Security features enabled:');
        logger.info('- JWT Authentication with secure secret validation');
        logger.info('- OAuth with state validation and PKCE');
        logger.info('- Comprehensive rate limiting');
        logger.info('- CSRF protection');
        logger.info('- Input sanitization and validation');
        logger.info('- SQL injection prevention');
        logger.info('- XSS protection');
        logger.info('- Security headers with Helmet');
        logger.info('- Structured logging with Winston');
        logger.info('- Email service ready');
        logger.info('- Database migration system active');
    }
    catch (error) {
        logger.error('Failed to start server', error);
        process.exit(1);
    }
}
startServer().catch(error => {
    console.error('💥 Startup error:', error);
    process.exit(1);
});
