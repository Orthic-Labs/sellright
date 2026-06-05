import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
 return (
 <div class="bg-white min-h-screen">
  <div class="max-w-4xl mx-auto px-4 py-16">
  <div class="text-center mb-16">
  <h1 class="text-4xl sm:text-5xl font-bold text-black mb-4">Privacy Policy</h1>
  <p class="text-lg text-gray-600 max-w-2xl mx-auto">
   How we collect, use, and protect your personal information in compliance with GDPR, CCPA, and other privacy laws.
  </p>
  </div>

  <div class="prose prose-lg max-w-none text-gray-600">
  <p>Last Updated: January 12, 2025</p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Introduction</h2>
  <p>
   Damned Designs ("we," "our," or "us") is a Wyoming corporation with a mailing address at 169 Madison Ave STE 15182, New York, NY 10016. We respect your privacy and are committed to protecting your personal information in compliance with applicable privacy laws, including the General Data Protection Regulation (GDPR), California Consumer Privacy Act (CCPA), and other relevant privacy regulations.
  </p>
  <p>
   This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you visit our website, make a purchase, create an account, or interact with us in any way. Please read this Privacy Policy carefully. By accessing or using our website, you acknowledge that you have read, understood, and agree to be bound by all the terms of this Privacy Policy.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Data Controller Information</h2>
  <p>
   For the purposes of GDPR and other applicable privacy laws, Damned Designs is the data controller responsible for your personal information. Our designated privacy contact can be reached at the contact information provided at the end of this policy.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Information We Collect</h2>

  <h3 class="text-xl font-bold mt-6 mb-3">Personal Information You Provide</h3>
  <p>We collect personal information that you voluntarily provide to us, including:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Account Information:</strong> Name, email address, phone number, username, and password</li>
   <li><strong>Billing and Shipping Information:</strong> Full name, billing address, shipping address, phone number</li>
   <li><strong>Payment Information:</strong> Credit card numbers, billing address, and other payment details (processed securely by our payment processors)</li>
   <li><strong>Order Information:</strong> Purchase history, product preferences, order details, and transaction records</li>
   <li><strong>Communication Data:</strong> Messages, emails, and other communications with our customer service team</li>
   <li><strong>Marketing Preferences:</strong> Subscription preferences and consent for marketing communications</li>
   <li><strong>Age Verification:</strong> Date of birth or age confirmation (required for certain products)</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Information Automatically Collected</h3>
  <p>We automatically collect certain information when you visit our website:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Device Information:</strong> IP address, device type, operating system, browser type and version</li>
   <li><strong>Usage Data:</strong> Pages viewed, time spent on pages, links clicked, referring website</li>
   <li><strong>Location Data:</strong> General geographic location based on IP address</li>
   <li><strong>Cookies and Tracking:</strong> Information collected through cookies, web beacons, and similar technologies</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Information from Third Parties</h3>
  <p>We may receive information about you from:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Payment Processors:</strong> Transaction verification and fraud prevention data</li>
   <li><strong>Shipping Partners:</strong> Delivery confirmation and tracking information</li>
   <li><strong>Marketing Partners:</strong> Demographic and interest data (with your consent)</li>
   <li><strong>Social Media:</strong> Public profile information if you interact with us on social platforms</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Legal Basis for Processing (GDPR)</h2>
  <p>Under GDPR Article 6, we process your personal information based on the following legal bases:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Contract Performance (Article 6(1)(b)):</strong> Processing necessary to fulfill our contract with you, including order processing, delivery, and customer service</li>
   <li><strong>Legitimate Interest (Article 6(1)(f)):</strong> Fraud prevention, website security, business analytics, and improving our services</li>
   <li><strong>Consent (Article 6(1)(a)):</strong> Marketing communications, cookies (where required), and optional data processing</li>
   <li><strong>Legal Obligation (Article 6(1)(c)):</strong> Compliance with tax, accounting, and other legal requirements</li>
   <li><strong>Vital Interests (Article 6(1)(d)):</strong> Protection of health and safety in emergency situations</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">How We Use Your Information</h2>
  <p>We use your personal information for the following purposes:</p>

  <h3 class="text-xl font-bold mt-6 mb-3">Order Processing and Fulfillment</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Processing and fulfilling your orders</li>
   <li>Payment processing and verification</li>
   <li>Shipping and delivery coordination</li>
   <li>Order tracking and status updates</li>
   <li>Handling returns and refunds</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Customer Service and Communication</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Responding to your inquiries and providing customer support</li>
   <li>Sending order confirmations and shipping notifications</li>
   <li>Communicating about your account or our services</li>
   <li>Resolving disputes and handling complaints</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Marketing and Promotional Activities</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Sending marketing emails and promotional offers (with your consent)</li>
   <li>Personalizing your shopping experience</li>
   <li>Recommending products based on your preferences</li>
   <li>Conducting surveys and market research</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Business Operations and Improvement</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Analyzing website usage and customer behavior</li>
   <li>Improving our website, products, and services</li>
   <li>Conducting business analytics and reporting</li>
   <li>Managing inventory and supply chain operations</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Legal and Security Purposes</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Detecting and preventing fraud, abuse, and security threats</li>
   <li>Complying with legal obligations and regulatory requirements</li>
   <li>Enforcing our Terms of Service and other agreements</li>
   <li>Protecting our rights, property, and safety</li>
   <li>Age verification for restricted products</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Data Retention Periods</h2>
  <p>We retain your personal information for different periods depending on the type of data and purpose:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Account Information:</strong> Retained while your account is active, plus 3 years after account closure</li>
   <li><strong>Order and Transaction Data:</strong> Retained for 7 years for tax and accounting purposes</li>
   <li><strong>Payment Information:</strong> Not stored by us; handled by PCI-compliant payment processors</li>
   <li><strong>Marketing Communications:</strong> Until you unsubscribe or withdraw consent</li>
   <li><strong>Website Analytics:</strong> Aggregated data retained for 26 months; individual data for 14 months</li>
   <li><strong>Customer Service Records:</strong> Retained for 3 years after last interaction</li>
   <li><strong>Legal and Compliance Data:</strong> Retained as required by applicable laws (typically 7-10 years)</li>
   <li><strong>Security Logs:</strong> Retained for 12 months for fraud prevention and security purposes</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Sharing Your Information</h2>
  <p>We may share your personal information with the following categories of recipients:</p>

  <h3 class="text-xl font-bold mt-6 mb-3">Service Providers and Processors</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Payment Processors:</strong> NMI, Sezzle, and other payment service providers</li>
   <li><strong>Shipping Companies:</strong> USPS, UPS, FedEx, and other delivery services</li>
   <li><strong>Technology Providers:</strong> Web hosting, email services, analytics platforms</li>
   <li><strong>Customer Service:</strong> Help desk and support ticket management systems</li>
   <li><strong>Marketing Services:</strong> Email marketing platforms and advertising networks (with consent)</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Legal and Regulatory Authorities</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Law enforcement agencies when required by law or court order</li>
   <li>Regulatory authorities for compliance purposes</li>
   <li>Tax authorities for tax reporting and compliance</li>
   <li>Legal counsel in connection with legal proceedings</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Business Transfers</h3>
  <p>
   In the event of a merger, acquisition, sale of assets, or bankruptcy, your personal information may be transferred to the successor entity, subject to the same privacy protections outlined in this policy.
  </p>

  <h3 class="text-xl font-bold mt-6 mb-3">Important: We Do Not Sell Personal Information</h3>
  <p>
   We do not sell, rent, or trade your personal information to third parties for monetary consideration. Any sharing is limited to the purposes outlined above and subject to appropriate data protection agreements.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Your Privacy Rights</h2>

  <h3 class="text-xl font-bold mt-6 mb-3">GDPR Rights (EU Residents)</h3>
  <p>If you are located in the European Union, you have the following rights under GDPR:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Right of Access (Article 15):</strong> Request a copy of the personal information we hold about you</li>
   <li><strong>Right to Rectification (Article 16):</strong> Request correction of inaccurate or incomplete personal information</li>
   <li><strong>Right to Erasure (Article 17):</strong> Request deletion of your personal information ("right to be forgotten")</li>
   <li><strong>Right to Restrict Processing (Article 18):</strong> Request limitation of how we process your personal information</li>
   <li><strong>Right to Data Portability (Article 20):</strong> Request transfer of your data to another service provider</li>
   <li><strong>Right to Object (Article 21):</strong> Object to processing based on legitimate interests or for direct marketing</li>
   <li><strong>Right to Withdraw Consent:</strong> Withdraw consent for processing based on consent at any time</li>
   <li><strong>Right to Lodge a Complaint:</strong> File a complaint with your local data protection authority</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">CCPA Rights (California Residents)</h3>
  <p>If you are a California resident, you have the following rights under CCPA:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Right to Know:</strong> Request information about the categories and specific pieces of personal information we collect</li>
   <li><strong>Right to Delete:</strong> Request deletion of your personal information</li>
   <li><strong>Right to Opt-Out:</strong> Opt-out of the sale of personal information (we do not sell personal information)</li>
   <li><strong>Right to Non-Discrimination:</strong> Not be discriminated against for exercising your privacy rights</li>
   <li><strong>Right to Correct:</strong> Request correction of inaccurate personal information</li>
   <li><strong>Right to Limit:</strong> Request limitation of use and disclosure of sensitive personal information</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">How to Exercise Your Rights</h3>
  <p>To exercise any of these rights, please contact us using the following methods:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Email:</strong> privacy@damneddesigns.com</li>
   <li><strong>Phone:</strong> (609) 997-8106</li>
   <li><strong>Mail:</strong> Damned Designs, Privacy Rights, 169 Madison Ave STE 15182, New York, NY 10016</li>
  </ul>
  <p>
   We will respond to your request within 30 days (GDPR) or 45 days (CCPA). We may need to verify your identity before processing your request to protect your personal information.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Cookies and Tracking Technologies</h2>
  <p>We use cookies and similar tracking technologies to enhance your browsing experience:</p>

  <h3 class="text-xl font-bold mt-6 mb-3">Types of Cookies We Use</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Essential Cookies:</strong> Required for website functionality, shopping cart, and security</li>
   <li><strong>Performance Cookies:</strong> Help us understand how visitors use our website</li>
   <li><strong>Functional Cookies:</strong> Remember your preferences and settings</li>
   <li><strong>Marketing Cookies:</strong> Used for advertising and remarketing (with your consent)</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Cookie Consent</h3>
  <p>
   We obtain your consent for non-essential cookies through our cookie banner. You can manage your cookie preferences at any time through your browser settings or by contacting us.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">International Data Transfers</h2>
  <p>
   Your personal information may be transferred to and processed in countries other than your country of residence, including the United States. We ensure appropriate safeguards are in place for international transfers:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Adequacy Decisions:</strong> Transfers to countries with adequate data protection levels</li>
   <li><strong>Standard Contractual Clauses:</strong> EU-approved contracts for data protection</li>
   <li><strong>Binding Corporate Rules:</strong> Internal data protection policies for multinational companies</li>
   <li><strong>Certification Schemes:</strong> Privacy Shield successors and similar frameworks</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Data Security</h2>
  <p>We implement comprehensive security measures to protect your personal information:</p>

  <h3 class="text-xl font-bold mt-6 mb-3">Technical Safeguards</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>SSL/TLS encryption for data transmission</li>
   <li>Secure data storage with encryption at rest</li>
   <li>Regular security audits and vulnerability assessments</li>
   <li>Access controls and authentication systems</li>
   <li>Firewall protection and intrusion detection</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Organizational Measures</h3>
  <ul class="list-disc pl-5 space-y-2">
   <li>Employee training on data protection and privacy</li>
   <li>Data processing agreements with third-party providers</li>
   <li>Regular privacy impact assessments</li>
   <li>Incident response and breach notification procedures</li>
   <li>Data minimization and purpose limitation practices</li>
  </ul>

  <p>
   While we implement robust security measures, no method of transmission over the Internet or electronic storage is 100% secure. We cannot guarantee absolute security but are committed to protecting your information using industry-standard practices.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Children's Privacy</h2>
  <p>
   Our website and services are not intended for children under 18 years of age. We do not knowingly collect personal information from children under 18. If we become aware that we have collected personal information from a child under 18, we will take steps to delete such information promptly.
  </p>
  <p>
   Given the nature of our products (knives, tactical tools, and other potentially dangerous items), age verification is required for purchases, and we strongly recommend parental supervision for any interaction with our website by minors.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Third-Party Links and Services</h2>
  <p>
   Our website may contain links to third-party websites, services, or applications. This Privacy Policy does not apply to these third-party services. We encourage you to read the privacy policies of any third-party services you visit or use.
  </p>
  <p>We are not responsible for the privacy practices or content of third-party websites or services.</p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">State-Specific Privacy Rights</h2>

  <h3 class="text-xl font-bold mt-6 mb-3">Additional State Rights</h3>
  <p>Residents of certain states may have additional privacy rights:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Virginia (VCDPA):</strong> Rights to access, correct, delete, and opt-out of targeted advertising</li>
   <li><strong>Colorado (CPA):</strong> Rights to access, correct, delete, and opt-out of targeted advertising and profiling</li>
   <li><strong>Connecticut (CTDPA):</strong> Rights to access, correct, delete, and opt-out of targeted advertising</li>
   <li><strong>Utah (UCPA):</strong> Rights to access, delete, and opt-out of targeted advertising</li>
  </ul>
  <p>Contact us using the information below to exercise these rights.</p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Data Breach Notification</h2>
  <p>
   In the event of a data breach that poses a risk to your rights and freedoms, we will notify you and relevant authorities as required by applicable law. For GDPR, we will notify the relevant supervisory authority within 72 hours and affected individuals without undue delay when required.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Changes to This Privacy Policy</h2>
  <p>
   We may update this Privacy Policy from time to time to reflect changes in our practices, legal requirements, or for other operational reasons. We will notify you of any material changes by:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Posting the updated policy on our website with a new "Last Updated" date</li>
   <li>Sending email notification to registered users for significant changes</li>
   <li>Displaying a prominent notice on our website</li>
  </ul>
  <p>
   Your continued use of our website after the effective date of the updated Privacy Policy constitutes acceptance of the changes.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Governing Law</h2>
  <p>
   This Privacy Policy is governed by the laws of the State of Wyoming, without regard to conflict of law principles. However, your privacy rights under GDPR, CCPA, and other applicable privacy laws remain in effect regardless of this governing law provision.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Contact Information</h2>
  <p>
   If you have questions, concerns, or requests regarding this Privacy Policy or our privacy practices, please contact us:
  </p>

  <h3 class="text-xl font-bold mt-6 mb-3">Privacy Contact</h3>
  <div class="mt-4">
   <p><strong>Damned Designs - Privacy Officer</strong></p>
   <p>169 Madison Ave STE 15182</p>
   <p>New York, NY 10016</p>
   <p>Email: privacy@damneddesigns.com</p>
   <p>Phone: (609) 997-8106</p>
   <p>Hours: Monday-Friday, 9:00 AM - 5:00 PM EST</p>
  </div>

  <h3 class="text-xl font-bold mt-6 mb-3">EU Representative (GDPR)</h3>
  <p>
   If you are located in the European Union and need to contact our EU representative, please use the privacy contact information above, and we will connect you with our designated EU representative.
  </p>

  <h3 class="text-xl font-bold mt-6 mb-3">Data Protection Authority Contacts</h3>
  <p>You have the right to lodge a complaint with your local data protection authority:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>EU:</strong> Contact your local Data Protection Authority</li>
   <li><strong>UK:</strong> Information Commissioner's Office (ICO)</li>
   <li><strong>California:</strong> California Attorney General's Office</li>
  </ul>

  <div class="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
   <p class="text-blue-800 font-semibold">
    <strong>Important Notice:</strong> This Privacy Policy complies with GDPR, CCPA, and other applicable privacy laws. We are committed to protecting your privacy and will respond to all privacy requests within the required timeframes.
   </p>
  </div>
  </div>
 </div>
 </div>
 );
});

export const head = () =>
 createSEOHead({
 title: 'Privacy Policy',
 description: 'Comprehensive privacy policy for Damned Designs. GDPR and CCPA compliant. Learn how we protect your data and respect your privacy rights.',
 noindex: false,
 });



import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
