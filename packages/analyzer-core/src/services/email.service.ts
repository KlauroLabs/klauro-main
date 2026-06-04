import { Logger } from './logger.service';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import * as handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';

export interface EmailOptions {
  to: string | string[];
  subject: string;
  template?: string;
  context?: Record<string, any>;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text?: string;
}

export class EmailService {
  private static instance: EmailService;
  private transporter: Transporter | null = null;
  private templates: Map<string, handlebars.TemplateDelegate> = new Map();
  private logger = new Logger('EmailService');
  private isProduction = process.env.NODE_ENV === 'production';
  
  private constructor() {
    this.initialize();
  }
  
  static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }
  
  private initialize(): void {
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
    } else {
      this.transporter = nodemailer.createTransport({
        jsonTransport: true,
      });
      
      this.logger.info('Email service initialized in development mode (emails will be logged, not sent)');
    }
    
    this.loadTemplates();
  }
  
  private async verifyConnection(): Promise<void> {
    if (!this.transporter || !this.isProduction) return;
    
    try {
      await this.transporter.verify();
      this.logger.info('Email service connected successfully');
    } catch (error) {
      this.logger.error('Email service connection failed', error);
    }
  }
  
  private loadTemplates(): void {
    const templates = {
      'welcome': {
        subject: 'Welcome to Klauro!',
        html: `
          <h1>Welcome to Klauro, {{firstName}}!</h1>
          <p>We're excited to have you on board.</p>
          <p>To get started, please verify your email address:</p>
          <a href="{{verificationUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
          <p>If you have any questions, feel free to reach out to our support team.</p>
          <p>Best regards,<br>The Klauro Team</p>
        `,
        text: `Welcome to Klauro, {{firstName}}! Please verify your email by visiting: {{verificationUrl}}`,
      },
      'verification': {
        subject: 'Verify your Klauro email address',
        html: `
          <h2>Email Verification</h2>
          <p>Hi {{firstName}},</p>
          <p>Please click the link below to verify your email address:</p>
          <a href="{{verificationUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
          <p>This link will expire in 24 hours.</p>
          <p>If you didn't create an account with Klauro, please ignore this email.</p>
        `,
        text: `Hi {{firstName}}, Please verify your email by visiting: {{verificationUrl}}. This link will expire in 24 hours.`,
      },
      'passwordReset': {
        subject: 'Reset your Klauro password',
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
        subject: 'You\'ve been invited to join {{organizationName}} on Klauro',
        html: `
          <h2>Organization Invitation</h2>
          <p>Hi {{recipientName}},</p>
          <p>{{inviterName}} has invited you to join <strong>{{organizationName}}</strong> on Klauro as a {{role}}.</p>
          <a href="{{invitationUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #17a2b8; color: white; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
          <p>This invitation will expire in 7 days.</p>
        `,
        text: `Hi {{recipientName}}, {{inviterName}} has invited you to join {{organizationName}} on Klauro. Accept the invitation: {{invitationUrl}}`,
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
  
  async send(options: EmailOptions): Promise<boolean> {
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
        from: process.env.EMAIL_FROM || 'noreply@klauro.io',
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
      } else {
        this.logger.debug('Email (dev mode)', {
          to: options.to,
          subject,
          template: options.template,
          html: html?.substring(0, 200),
        });
      }
      
      return true;
    } catch (error) {
      this.logger.error('Failed to send email', error, {
        to: options.to,
        subject: options.subject,
        template: options.template,
      });
      return false;
    }
  }
  
  async sendWelcomeEmail(user: {
    email: string;
    firstName?: string;
    verificationToken: string;
  }): Promise<boolean> {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${user.verificationToken}`;
    
    return this.send({
      to: user.email,
      subject: 'Welcome to Klauro!',
      template: 'welcome',
      context: {
        firstName: user.firstName || 'there',
        verificationUrl,
      },
    });
  }
  
  async sendVerificationEmail(user: {
    email: string;
    firstName?: string;
    verificationToken: string;
  }): Promise<boolean> {
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
  
  async sendPasswordResetEmail(user: {
    email: string;
    firstName?: string;
    resetToken: string;
  }): Promise<boolean> {
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
  
  async sendInvitationEmail(invitation: {
    recipientEmail: string;
    recipientName?: string;
    inviterName: string;
    organizationName: string;
    role: string;
    invitationToken: string;
  }): Promise<boolean> {
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
  
  async sendSecurityAlert(alert: {
    email: string;
    firstName?: string;
    alertType: string;
    ipAddress: string;
    location?: string;
    device?: string;
  }): Promise<boolean> {
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
  
  async sendBulkEmails(recipients: EmailOptions[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    
    for (const recipient of recipients) {
      const success = await this.send(recipient);
      if (success) {
        sent++;
      } else {
        failed++;
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.logger.info(`Bulk email completed: ${sent} sent, ${failed} failed`);
    
    return { sent, failed };
  }
}

export const emailService = EmailService.getInstance();