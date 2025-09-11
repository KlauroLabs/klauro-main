import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
// import { Strategy as GitHubStrategy } from 'passport-github2';
// import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
// import { Strategy as MicrosoftStrategy } from 'passport-microsoft';
// import { Strategy as GitLabStrategy } from 'passport-gitlab2';
import { authConfig } from '../../config/auth.config';
import { JWTPayload, OAuthProfile } from '../../types';

export function initializePassport() {
  // JWT Strategy for API authentication
  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: authConfig.jwt.accessSecret,
        issuer: authConfig.jwt.issuer,
        audience: authConfig.jwt.audience,
      },
      async (payload: JWTPayload, done) => {
        try {
          if (payload.type !== 'access') {
            return done(null, false);
          }
          return done(null, payload);
        } catch (error) {
          return done(error, false);
        }
      }
    )
  );

  // OAuth Strategies temporarily disabled for startup
  /*
  // GitHub OAuth Strategy
  if (authConfig.oauth.github.clientId) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: authConfig.oauth.github.clientId,
          clientSecret: authConfig.oauth.github.clientSecret,
          callbackURL: authConfig.oauth.github.callbackUrl,
          scope: authConfig.oauth.github.scope as string[],
        },
        async (accessToken: string, refreshToken: string, profile: any, done: any) => {
          try {
            const oauthProfile: OAuthProfile = {
              id: profile.id,
              email: profile.emails?.[0]?.value || profile.username + '@github.local',
              name: profile.displayName,
              first_name: profile.name?.givenName,
              last_name: profile.name?.familyName,
              avatar_url: profile.photos?.[0]?.value,
              provider: 'github',
            };
            return done(null, oauthProfile);
          } catch (error) {
            return done(error, null);
          }
        }
      )
    );
  }

  // Google OAuth Strategy
  if (authConfig.oauth.google.clientId) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: authConfig.oauth.google.clientId,
          clientSecret: authConfig.oauth.google.clientSecret,
          callbackURL: authConfig.oauth.google.callbackUrl,
          scope: authConfig.oauth.google.scope,
        },
        async (accessToken: string, refreshToken: string, profile: any, done: any) => {
          try {
            const oauthProfile: OAuthProfile = {
              id: profile.id,
              email: profile.emails?.[0]?.value,
              name: profile.displayName,
              first_name: profile.name?.givenName,
              last_name: profile.name?.familyName,
              avatar_url: profile.photos?.[0]?.value,
              provider: 'google',
            };
            return done(null, oauthProfile);
          } catch (error) {
            return done(error, null);
          }
        }
      )
    );
  }

  // Microsoft OAuth Strategy
  if (authConfig.oauth.microsoft.clientId) {
    passport.use(
      new MicrosoftStrategy(
        {
          clientID: authConfig.oauth.microsoft.clientId,
          clientSecret: authConfig.oauth.microsoft.clientSecret,
          callbackURL: authConfig.oauth.microsoft.callbackUrl,
          scope: authConfig.oauth.microsoft.scope,
        },
        async (accessToken: string, refreshToken: string, profile: any, done: any) => {
          try {
            const oauthProfile: OAuthProfile = {
              id: profile.id,
              email: profile.emails?.[0]?.value,
              name: profile.displayName,
              first_name: profile.name?.givenName,
              last_name: profile.name?.familyName,
              avatar_url: profile.photos?.[0]?.value,
              provider: 'microsoft',
            };
            return done(null, oauthProfile);
          } catch (error) {
            return done(error, null);
          }
        }
      )
    );
  }

  // GitLab OAuth Strategy
  if (authConfig.oauth.gitlab.clientId) {
    passport.use(
      new GitLabStrategy(
        {
          clientID: authConfig.oauth.gitlab.clientId,
          clientSecret: authConfig.oauth.gitlab.clientSecret,
          callbackURL: authConfig.oauth.gitlab.callbackUrl,
          scope: authConfig.oauth.gitlab.scope as string[],
        },
        async (accessToken: string, refreshToken: string, profile: any, done: any) => {
          try {
            const oauthProfile: OAuthProfile = {
              id: profile.id,
              email: profile.emails?.[0]?.value,
              name: profile.displayName || profile.username,
              first_name: profile.name?.givenName,
              last_name: profile.name?.familyName,
              avatar_url: profile.avatarUrl,
              provider: 'gitlab',
            };
            return done(null, oauthProfile);
          } catch (error) {
            return done(error, null);
          }
        }
      )
    );
  }
  */

  // Serialize/Deserialize user for session
  passport.serializeUser((user: any, done) => {
    done(null, user);
  });

  passport.deserializeUser((user: any, done) => {
    done(null, user);
  });
}

export default passport;