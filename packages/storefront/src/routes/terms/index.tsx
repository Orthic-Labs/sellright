import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
 return (
 <div class="bg-white min-h-screen">
  <div class="max-w-4xl mx-auto px-4 py-16">
  <div class="text-center mb-16">
  <h1 class="text-4xl sm:text-5xl font-bold text-black mb-4">Terms of Service</h1>
  <p class="text-lg text-gray-600 max-w-2xl mx-auto">
   The rules, guidelines, and agreements for using our website and purchasing our products.
  </p>
  </div>

  <div class="prose prose-lg max-w-none text-gray-600">
  <p>Last Updated: January 12, 2025</p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Introduction</h2>
  <p>
   Welcome to Damned Designs. These Terms of Service ("Terms") govern your access to and use of our website, products, and services operated by Damned Designs, a Wyoming corporation with a mailing address at 169 Madison Ave STE 15182, New York, NY 10016. By accessing or using our website, you agree to be bound by these Terms and our Privacy Policy.
  </p>
  <p>
   Please read these Terms carefully before using our website. If you do not agree to all the terms and conditions of this agreement, you may not access or use our website or services.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Age Restrictions and Eligibility</h2>
  <p>
   You must be at least 18 years of age to purchase products from our website. By using our website and purchasing our products, you represent and warrant that you are at least 18 years old and have the legal capacity to enter into these Terms. Some of our products may have additional age restrictions as required by applicable law.
  </p>
  <p>
   <strong>IMPORTANT:</strong> Many of our products, including knives, tactical tools, and small decorative items, are intended for adult use only and may be dangerous if misused. Parents and guardians are responsible for ensuring that minors do not access or use these products.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Product Categories and Warnings</h2>
  <h3 class="text-xl font-bold mt-6 mb-3">Sharp Objects and Weapons</h3>
  <p>
   We sell knives, tactical tools, and other sharp objects that are inherently dangerous. These products are sold for legitimate purposes including collecting, outdoor activities, professional use, and legal self-defense where permitted by law. By purchasing these items, you acknowledge that:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>These products are sharp, dangerous, and can cause serious injury or death if misused</li>
   <li>You are legally permitted to purchase, possess, and use these items in your jurisdiction</li>
   <li>You will use these products responsibly and in accordance with all applicable laws</li>
   <li>You will store these products safely and away from children and unauthorized users</li>
   <li>You assume all risks associated with the purchase, possession, and use of these products</li>
  </ul>

  <h3 class="text-xl font-bold mt-6 mb-3">Small Items and Choking Hazards</h3>
  <p>
   Some of our products, including beads and small decorative items, may present choking hazards, particularly to children under 3 years of age. By purchasing these items, you acknowledge that:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Small parts may present choking hazards to young children</li>
   <li>These products are not suitable for children under 3 years of age</li>
   <li>Adult supervision is required when these products are used by or around children</li>
   <li>You will keep these products away from young children and pets</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Legal Compliance and Restrictions</h2>
  <p>
   You are solely responsible for ensuring that your purchase, possession, and use of our products complies with all applicable federal, state, and local laws in your jurisdiction. Some products may be restricted or prohibited in certain areas. By purchasing from us, you represent and warrant that:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>You are legally permitted to purchase and possess the products you order</li>
   <li>You will not use our products for any illegal purpose</li>
   <li>You will not resell our products to prohibited persons or in prohibited jurisdictions</li>
   <li>You understand that we cannot provide legal advice regarding the legality of products in your area</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Use of Our Website</h2>
  <h3 class="text-xl font-bold mt-6 mb-3">Account Registration</h3>
  <p>
   To access certain features of our website, you may be required to register for an account. You agree to provide accurate, current, and complete information during the registration process and to update such information to keep it accurate, current, and complete.
  </p>

  <h3 class="text-xl font-bold mt-6 mb-3">Prohibited Activities</h3>
  <p>You agree not to:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Use our website in any way that violates any applicable federal, state, local, or international law or regulation</li>
   <li>Purchase products for illegal purposes or for resale to prohibited persons</li>
   <li>Use our website to transmit or send unsolicited commercial communications</li>
   <li>Engage in any conduct that restricts or inhibits anyone's use or enjoyment of our website</li>
   <li>Attempt to gain unauthorized access to, interfere with, damage, or disrupt any parts of our website</li>
   <li>Use any robot, spider, or other automatic device to access our website</li>
   <li>Introduce any viruses, Trojan horses, worms, or other material that is malicious or technologically harmful</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Products and Purchases</h2>
  <h3 class="text-xl font-bold mt-6 mb-3">Product Information</h3>
  <p>
   We strive to display our products and their features accurately on our website. However, we do not guarantee that product descriptions, colors, or other content on our website are accurate, complete, reliable, current, or error-free. All product specifications, dimensions, and features are approximate and may vary.
  </p>

  <h3 class="text-xl font-bold mt-6 mb-3">Pricing and Payment</h3>
  <p>
   All prices are shown in US dollars and do not include taxes or shipping costs, which are calculated at checkout. We reserve the right to change prices at any time without notice. Payment must be made at the time of purchase through our secure payment system.
  </p>

  <h3 class="text-xl font-bold mt-6 mb-3">Order Acceptance and Fulfillment</h3>
  <p>
   Your receipt of an order confirmation does not constitute our acceptance of your order. We reserve the right to limit or cancel quantities purchased per person, per household, or per order. We also reserve the right to refuse any order at our sole discretion, including orders that we believe may violate applicable laws or these Terms.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Assumption of Risk and Product Liability</h2>
  <p>
   <strong>BY PURCHASING AND USING OUR PRODUCTS, YOU EXPRESSLY ASSUME ALL RISKS ASSOCIATED WITH THEIR USE.</strong> You acknowledge and agree that:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Inherent Dangers:</strong> Our products, including but not limited to knives, tactical tools, and sharp objects, are inherently dangerous and can cause serious bodily injury, permanent disability, or death if misused, handled improperly, or used by untrained individuals.</li>
   <li><strong>Assumption of Risk:</strong> You voluntarily assume all risks of injury, damage, or loss that may result from the purchase, possession, handling, or use of our products, whether such risks are known or unknown, foreseeable or unforeseeable.</li>
   <li><strong>Product Misuse:</strong> We are not liable for any injuries, damages, or losses resulting from the misuse, abuse, or improper handling of our products, including but not limited to using products for purposes other than their intended use.</li>
   <li><strong>Third Party Harm:</strong> You agree that you are solely responsible for any harm, injury, or damage caused to third parties through your use, misuse, or negligent handling of our products.</li>
   <li><strong>Choking Hazards:</strong> For products containing small parts, you assume all responsibility for preventing access by children and ensuring appropriate supervision when such products are present around minors.</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Intellectual Property</h2>
  <p>
   Our website and its entire contents, features, and functionality (including but not limited to all information, software, text, displays, images, video, and audio) are owned by Damned Designs, its licensors, or other providers of such material and are protected by United States and international copyright, trademark, patent, trade secret, and other intellectual property or proprietary rights laws.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Comprehensive Disclaimer of Warranties</h2>
  <p>
   TO THE FULLEST EXTENT PERMITTED BY LAW, OUR WEBSITE AND PRODUCTS ARE PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS, WITHOUT ANY WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED. WE EXPRESSLY DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE</li>
   <li>WARRANTIES OF NON-INFRINGEMENT</li>
   <li>WARRANTIES THAT PRODUCTS WILL BE FREE FROM DEFECTS OR SUITABLE FOR ANY PARTICULAR USE</li>
   <li>WARRANTIES REGARDING THE SAFETY, RELIABILITY, OR PERFORMANCE OF OUR PRODUCTS</li>
   <li>WARRANTIES THAT OUR PRODUCTS WILL NOT CAUSE INJURY OR DAMAGE</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Comprehensive Limitation of Liability</h2>
  <p>
   TO THE FULLEST EXTENT PERMITTED BY LAW, IN NO EVENT SHALL DAMNED DESIGNS, ITS AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, LICENSORS, OR SERVICE PROVIDERS BE LIABLE FOR ANY DAMAGES OF ANY KIND, INCLUDING BUT NOT LIMITED TO:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>PERSONAL INJURY, BODILY HARM, OR DEATH</li>
   <li>PROPERTY DAMAGE OR DESTRUCTION</li>
   <li>DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES</li>
   <li>LOST PROFITS, LOST DATA, OR BUSINESS INTERRUPTION</li>
   <li>DAMAGES ARISING FROM PRODUCT DEFECTS, MISUSE, OR MALFUNCTION</li>
   <li>DAMAGES CAUSED TO THIRD PARTIES BY YOUR USE OF OUR PRODUCTS</li>
  </ul>
  <p>
   THIS LIMITATION APPLIES REGARDLESS OF THE LEGAL THEORY ON WHICH THE CLAIM IS BASED, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, AND EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
  </p>
  <p>
   IN JURISDICTIONS THAT DO NOT ALLOW THE EXCLUSION OR LIMITATION OF LIABILITY FOR CONSEQUENTIAL OR INCIDENTAL DAMAGES, OUR LIABILITY SHALL BE LIMITED TO THE MAXIMUM EXTENT PERMITTED BY LAW. IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU EXCEED THE AMOUNT YOU PAID FOR THE SPECIFIC PRODUCT THAT GAVE RISE TO THE CLAIM.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Comprehensive Indemnification</h2>
  <p>
   You agree to defend, indemnify, and hold harmless Damned Designs, its affiliates, licensors, service providers, officers, directors, employees, contractors, agents, suppliers, successors, and assigns from and against any and all claims, liabilities, damages, judgments, awards, losses, costs, expenses, or fees (including reasonable attorneys' fees) arising out of or relating to:
  </p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Your purchase, possession, or use of our products</li>
   <li>Your violation of these Terms or any applicable law or regulation</li>
   <li>Your violation of the rights of any third party</li>
   <li>Any injury, damage, or harm caused by or resulting from your use of our products</li>
   <li>Any misuse, abuse, or improper handling of our products</li>
   <li>Any claims by third parties arising from your use of our products</li>
  </ul>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Returns and Refunds</h2>
  <p>
   Due to the nature of our products and safety considerations, all sales are final unless the product arrives damaged or defective. Please see our Returns Policy for detailed information about our return procedures and conditions.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Changes to Terms of Service</h2>
  <p>
   We may revise and update these Terms from time to time at our sole discretion. All changes are effective immediately when we post them. Your continued use of our website following the posting of revised Terms means that you accept and agree to the changes.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Governing Law and Jurisdiction</h2>
  <p>
   These Terms and any dispute or claim arising out of or related to them, their subject matter, or their formation shall be governed by and construed in accordance with the laws of the State of Wyoming, without giving effect to any choice or conflict of law provision or rule. Any legal action or proceeding arising under these Terms shall be brought exclusively in the federal or state courts located in Wyoming, and you hereby consent to the personal jurisdiction and venue therein.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Severability</h2>
  <p>
   If any provision of these Terms is held to be invalid, illegal, or unenforceable, the validity, legality, and enforceability of the remaining provisions shall not in any way be affected or impaired thereby, and such provision shall be deemed modified to the minimum extent necessary to make such provision valid, legal, and enforceable.
  </p>

  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Contact Us</h2>
  <p>
   If you have any questions about these Terms of Service, please contact us at:
  </p>
  <div class="mt-4">
   <p><strong>Damned Designs</strong></p>
   <p>169 Madison Ave STE 15182</p>
   <p>New York, NY 10016</p>
   <p>Email: legal@damneddesigns.com</p>
   <p>Phone: (609) 997-8106</p>
  </div>
  </div>
 </div>
 </div>
 );
});

export const head = () =>
 createSEOHead({
 title: 'Terms of Service',
 description: 'Terms of Service for Damned Designs. Rules, guidelines, and agreements for using our website and purchasing our products.',
 noindex: false,
 });



import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
