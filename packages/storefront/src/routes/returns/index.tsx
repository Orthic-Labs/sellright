import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
 return (
 <div class="bg-white min-h-screen">
  <div class="max-w-4xl mx-auto px-4 py-16">
  <div class="text-center mb-16">
  <h1 class="text-4xl sm:text-5xl font-bold text-black mb-4">Returns & Refund Policy</h1>
  <p class="text-lg text-gray-600 max-w-2xl mx-auto">
   Our policy for returns, refunds, and exchanges on all Damned Designs products.
  </p>
  </div>

  <div class="prose prose-lg max-w-none text-gray-600">
  <p>Last Updated: January 12, 2025</p>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Overview</h2>
  <p>
   Due to the nature of our products, which include knives, tactical tools, and other potentially dangerous items, we maintain a strict returns policy to ensure safety and legal compliance. All sales are final unless the product arrives damaged, defective, or significantly different from what was ordered.
  </p>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Eligible Returns</h2>
  <p>We will accept returns only in the following circumstances:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Damaged Products:</strong> Items that arrive physically damaged due to shipping or handling</li>
   <li><strong>Manufacturing Defects:</strong> Products with clear manufacturing defects that affect functionality or safety</li>
   <li><strong>Wrong Item Shipped:</strong> If we shipped an incorrect product</li>
   <li><strong>Significantly Different:</strong> If the product received is significantly different from the description or images on our website</li>
  </ul>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Return Requirements</h2>
  <h3 class="text-xl font-bold mt-6 mb-3">Time Limit</h3>
  <p>
   Returns must be initiated within <strong>7 days</strong> of delivery. After this period, all sales become final with no exceptions.
  </p>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Condition Requirements</h3>
  <p>To be eligible for return, items must:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Be unused and in the same condition as received</li>
   <li>Include all original packaging, documentation, and accessories</li>
   <li>Not show any signs of use, wear, or modification</li>
   <li>Be accompanied by photographic evidence of damage or defect (if applicable)</li>
  </ul>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Documentation Required</h3>
  <p>All return requests must include:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Order number and purchase date</li>
   <li>Clear photographs showing the issue (for damaged/defective items)</li>
   <li>Detailed description of the problem</li>
   <li>Proof of delivery (tracking information)</li>
  </ul>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Non-Returnable Items</h2>
  <p>The following items cannot be returned under any circumstances:</p>
  <ul class="list-disc pl-5 space-y-2">
   <li>Items that have been used, carried, or handled beyond initial inspection</li>
   <li>Products showing any signs of wear, scratches, or modification</li>
   <li>Items returned after the 7-day return window</li>
   <li>Products damaged due to misuse, abuse, or normal wear</li>
   <li>Items purchased with special discounts or promotional codes (unless defective)</li>
   <li>Custom or personalized products</li>
  </ul>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Return Process</h2>
  <h3 class="text-xl font-bold mt-6 mb-3">Step 1: Contact Us</h3>
  <p>
   Before returning any item, you must contact our customer service team at <strong>returns@damneddesigns.com</strong> or call <strong>(609) 997-8106</strong>. Include your order number and detailed description of the issue.
  </p>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Step 2: Return Authorization</h3>
  <p>
   If your return is approved, we will provide you with a Return Merchandise Authorization (RMA) number and detailed return instructions. <strong>Do not ship any items without an RMA number.</strong>
  </p>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Step 3: Package and Ship</h3>
  <p>
   Package the item securely in its original packaging. Include the RMA number clearly marked on the outside of the package. Ship to the address provided in your return authorization.
  </p>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Step 4: Inspection</h3>
  <p>
   Once we receive your return, we will inspect the item within 3-5 business days. We will notify you of the inspection results and next steps.
  </p>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Refunds</h2>
  <h3 class="text-xl font-bold mt-6 mb-3">Approved Returns</h3>
  <p>
   If your return is approved after inspection, we will process your refund within 5-7 business days. Refunds will be issued to the original payment method used for the purchase.
  </p>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Refund Amount</h3>
  <p>
   Refunds will include the full purchase price of the item. Original shipping costs are non-refundable unless the return is due to our error (wrong item shipped, defective product, etc.).
  </p>
  
  <h3 class="text-xl font-bold mt-6 mb-3">Processing Time</h3>
  <p>
   Please allow 5-10 business days for refunds to appear on your statement after processing, depending on your payment method and financial institution.
  </p>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Exchanges</h2>
  <p>
   We do not offer direct exchanges. If you need a different size, model, or product, you must return the original item (if eligible) and place a new order for the desired item.
  </p>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Shipping Costs</h2>
  <ul class="list-disc pl-5 space-y-2">
   <li><strong>Customer Error:</strong> Customer pays return shipping costs</li>
   <li><strong>Our Error:</strong> We pay return shipping costs and provide a prepaid return label</li>
   <li><strong>Defective Products:</strong> We pay return shipping costs and provide a prepaid return label</li>
  </ul>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Warranty Information</h2>
  <p>
   Manufacturing defects are covered under our return policy for 7 days from delivery. After this period, warranty claims should be directed to the manufacturer if applicable. We do not provide extended warranties beyond the return period.
  </p>
  
  <h2 class="text-2xl font-bold text-black mt-8 mb-4">Contact Information</h2>
  <p>
   For all return-related inquiries, please contact us:
  </p>
  <div class="mt-4">
   <p><strong>Returns Department</strong></p>
   <p>Damned Designs</p>
   <p>169 Madison Ave STE 15182</p>
   <p>New York, NY 10016</p>
   <p>Email: returns@damneddesigns.com</p>
   <p>Phone: (609) 997-8106</p>
   <p>Hours: Monday-Friday, 9:00 AM - 5:00 PM EST</p>
  </div>
  
  <div class="mt-8 p-4 bg-red-50 border border-red-200 rounded-lg">
   <p class="text-red-800 font-semibold">
    <strong>Important Safety Notice:</strong> Due to the dangerous nature of our products, we cannot accept returns of items that have been used, carried, or handled beyond initial inspection. This policy is in place for the safety of our customers and staff.
   </p>
  </div>
  </div>
 </div>
 </div>
 );
});

export const head = () =>
 createSEOHead({
 title: 'Returns & Refund Policy',
 description: 'Returns and refund policy for Damned Designs. Learn about our return procedures and conditions.',
 noindex: false,
 });


import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
