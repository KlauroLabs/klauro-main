"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializePassport = initializePassport;
const passport_1 = __importDefault(require("passport"));
const passport_jwt_1 = require("passport-jwt");
const auth_config_1 = require("../../config/auth.config");
function initializePassport() {
    passport_1.default.use(new passport_jwt_1.Strategy({
        jwtFromRequest: passport_jwt_1.ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: auth_config_1.authConfig.jwt.accessSecret,
        issuer: auth_config_1.authConfig.jwt.issuer,
        audience: auth_config_1.authConfig.jwt.audience,
    }, async (payload, done) => {
        try {
            if (payload.type !== 'access') {
                return done(null, false);
            }
            return done(null, payload);
        }
        catch (error) {
            return done(error, false);
        }
    }));
    passport_1.default.serializeUser((user, done) => {
        done(null, user);
    });
    passport_1.default.deserializeUser((user, done) => {
        done(null, user);
    });
}
exports.default = passport_1.default;
