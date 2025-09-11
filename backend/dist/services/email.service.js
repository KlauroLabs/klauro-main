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
exports.emailService = exports.EmailService = void 0;
const logger_service_1 = require("./logger.service");
const nodemailer = __importStar(require("nodemailer"));
const handlebars = __importStar(require("handlebars"));
class EmailService {
    constructor() {
        this.transporter = null;
        this.templates = new Map();
        this.logger = new logger_service_1.Logger('EmailService');
        this.isProduction = process.env.NODE_ENV === 'production';
        this.initialize();
    }
    static getInstance() {
        if (!EmailService.instance) {
            EmailService.instance = new EmailService();
        }
        return EmailService.instance;
    }
    initialize() {
        if (this.isProduction) {
            this.transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            });
            this.verifyConnection();
        }
        else {
            this.transporter = nodemailer.createTransport({
                jsonTransport: true,
            });
            this.logger.info('Email service initialized in development mode (emails will be logged, not sent)');
        }
        this.loadTemplates();
    }
    async verifyConnection() {
        if (!this.transporter || !this.isProduction)
            return;
        try {
            await this.transporter.verify();
            this.logger.info('Email service connected successfully');
        }
        catch (error) {
            this.logger.error('Email service connection failed', error);
        }
    }
    loadTemplates() {
        const templates = {
            'welcome': {
                subject: 'Welcome to Unravl!',
                html: `
          <h1>Welcome to Unravl, {{firstName}}!</h1>
          <p>We're excited to have you on board.</p>
          <p>To get started, please verify your email address:</p>
          <a href="{{verificationUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
          <p>If you have any questions, feel free to reach out to our support team.</p>
          <p>Best regards,<br>The Unravl Team</p>
        `,
                text: `Welcome to Unravl, {{firstName}}! Please verify your email by visiting: {{verificationUrl}}`,
            },
            'verification': {
                subject: 'Verify your Unravl email address',
                html: `
          <h2>Email Verification</h2>
          <p>Hi {{firstName}},</p>
          <p>Please click the link below to verify your email address:</p>
          <a href="{{verificationUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
          <p>This link will expire in 24 hours.</p>
          <p>If you didn't create an account with Unravl, please ignore this email.</p>
        `,
                text: `Hi {{firstName}}, Please verify your email by visiting: {{verificationUrl}}. This link will expire in 24 hours.`,
            },
            'passwordReset': {
                subject: 'Reset your Unravl password',
                html: `
          <h2>Password Reset Request</h2>
          <p>Hi {{firstName}},</p>
          <p>We received a request to reset your password. Click the link below to create a new password:</p>
          <a href="{{resetUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #ffc107; color: black; text-decoration: none; border-radius: 5px;">Reset Password</a>
          <p>This link will expire in 1 hour.</p>
          <p>If you didn't request this, please ignore this email. Your password won't be changed.</p>
          <p>For security reasons, if you didn't request this reset, we recommend you change your password.</p>
        `,
                text: `Hi {{firstName}}, Reset your password by visiting: {{resetUrl}}. This link will expire in 1 hour.`,
            },
            'invitation': {
                subject: 'You\'ve been invited to join {{organizationName}} on Unravl',
                html: `
          <h2>Organization Invitation</h2>
          <p>Hi {{recipientName}},</p>
          <p>{{inviterName}} has invited you to join <strong>{{organizationName}}</strong> on Unravl as a {{role}}.</p>
          <a href="{{invitationUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #17a2b8; color: white; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
          <p>This invitation will expire in 7 days.</p>
        `,
                text: `Hi {{recipientName}}, {{inviterName}} has invited you to join {{organizationName}} on Unravl. Accept the invitation: {{invitationUrl}}`,
            },
            'securityAlert': {
                subject: 'Security Alert: {{alertType}}',
                html: `
          <h2>Security Alert</h2>
          <p>Hi {{firstName}},</p>
          <p>We detected {{alertType}} on your account:</p>
          <ul>
            <li>Date: {{date}}</li>
            <li>IP Address: {{ipAddress}}</li>
            <li>Location: {{location}}</li>
            <li>Device: {{device}}</li>
          </ul>
          <p>If this was you, you can safely ignore this email.</p>
          <p>If this wasn't you, please <a href="{{secureAccountUrl}}">secure your account immediately</a>.</p>
        `,
                text: `Security Alert: {{alertType}} detected on {{date}} from IP {{ipAddress}}. If this wasn't you, secure your account: {{secureAccountUrl}}`,
            },
        };
        for (const [name, template] of Object.entries(templates)) {
            this.templates.set(`${name}-html`, handlebars.compile(template.html));
            this.templates.set(`${name}-text`, handlebars.compile(template.text));
            this.templates.set(`${name}-subject`, handlebars.compile(template.subject));
        }
        this.logger.info(`Loaded ${this.templates.size / 3} email templates`);
    }
    async send(options) {
        try {
            if (!this.transporter) {
                throw new Error('Email service not initialized');
            }
            let html = options.html;
            let text = options.text;
            let subject = options.subject;
            if (options.template && options.context) {
                const htmlTemplate = this.templates.get(`${options.template}-html`);
                const textTemplate = this.templates.get(`${options.template}-text`);
                const subjectTemplate = this.templates.get(`${options.template}-subject`);
                if (htmlTemplate) {
                    html = htmlTemplate(options.context);
                }
                if (textTemplate) {
                    text = textTemplate(options.context);
                }
                if (subjectTemplate) {
                    subject = subjectTemplate(options.context);
                }
            }
            const mailOptions = {
                from: process.env.EMAIL_FROM || 'noreply@unravl.io',
                to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
                subject,
                html,
                text,
                cc: options.cc,
                bcc: options.bcc,
                replyTo: options.replyTo,
                attachments: options.attachments,
            };
            if (this.isProduction) {
                const info = await this.transporter.sendMail(mailOptions);
                this.logger.info('Email sent successfully', {
                    messageId: info.messageId,
                    to: options.to,
                    subject,
                });
            }
            else {
                this.logger.debug('Email (dev mode)', {
                    to: options.to,
                    subject,
                    template: options.template,
                    html: html?.substring(0, 200),
                });
            }
            return true;
        }
        catch (error) {
            this.logger.error('Failed to send email', error, {
                to: options.to,
                subject: options.subject,
                template: options.template,
            });
            return false;
        }
    }
    async sendWelcomeEmail(user) {
        const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${user.verificationToken}`;
        return this.send({
            to: user.email,
            subject: 'Welcome to Unravl!',
            template: 'welcome',
            context: {
                firstName: user.firstName || 'there',
                verificationUrl,
            },
        });
    }
    async sendVerificationEmail(user) {
        const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${user.verificationToken}`;
        return this.send({
            to: user.email,
            subject: 'Verify Your Email Address',
            template: 'verification',
            context: {
                firstName: user.firstName || 'there',
                verificationUrl,
            },
        });
    }
    async sendPasswordResetEmail(user) {
        const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${user.resetToken}`;
        return this.send({
            to: user.email,
            subject: 'Reset Your Password',
            template: 'passwordReset',
            context: {
                firstName: user.firstName || 'there',
                resetUrl,
            },
        });
    }
    async sendInvitationEmail(invitation) {
        const invitationUrl = `${process.env.FRONTEND_URL}/accept-invitation?token=${invitation.invitationToken}`;
        return this.send({
            to: invitation.recipientEmail,
            subject: `Invitation to join ${invitation.organizationName}`,
            template: 'invitation',
            context: {
                recipientName: invitation.recipientName || 'there',
                inviterName: invitation.inviterName,
                organizationName: invitation.organizationName,
                role: invitation.role,
                invitationUrl,
            },
        });
    }
    async sendSecurityAlert(alert) {
        const secureAccountUrl = `${process.env.FRONTEND_URL}/security`;
        return this.send({
            to: alert.email,
            subject: 'Security Alert - Unusual Activity Detected',
            template: 'securityAlert',
            context: {
                firstName: alert.firstName || 'there',
                alertType: alert.alertType,
                date: new Date().toLocaleString(),
                ipAddress: alert.ipAddress,
                location: alert.location || 'Unknown',
                device: alert.device || 'Unknown',
                secureAccountUrl,
            },
        });
    }
    async sendBulkEmails(recipients) {
        let sent = 0;
        let failed = 0;
        for (const recipient of recipients) {
            const success = await this.send(recipient);
            if (success) {
                sent++;
            }
            else {
                failed++;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.logger.info(`Bulk email completed: ${sent} sent, ${failed} failed`);
        return { sent, failed };
    }
}
exports.EmailService = EmailService;
exports.emailService = EmailService.getInstance();
