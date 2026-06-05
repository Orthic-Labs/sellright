/**
 * Analytics endpoint for receiving performance metrics
 * Handles performance data collection and optional forwarding to analytics services
 */

import type { RequestHandler } from '@qwik.dev/router';

interface PerformanceMetric {
  metric: string;
  value: number;
  context: string;
  timestamp: number;
  userAgent: string;
  url: string;
}

export const onPost: RequestHandler = async ({ request, json }) => {
  try {
    const requestBody = await request.text();
    const metric: PerformanceMetric = JSON.parse(requestBody);
    
    // Validate the metric data
    if (!metric.metric || typeof metric.value !== 'number' || !metric.context) {
      throw json(400, { error: 'Invalid metric data' });
    }
    
    // Log the metric (in production, you'd want to use proper logging)
    console.log('[Performance Metric]', {
      metric: metric.metric,
      value: metric.value,
      context: metric.context,
      timestamp: new Date(metric.timestamp).toISOString(),
      url: metric.url
    });
    
    // Here you can forward metrics to your analytics service
    await forwardToAnalyticsService(metric);
    
    // Store in database if needed
    await storeMetricInDatabase(metric);
    
    throw json(200, { success: true, message: 'Metric recorded' });
    
  } catch (error) {
    console.error('Error processing performance metric:', error);
    throw json(500, { error: 'Failed to process metric' });
  }
};

async function forwardToAnalyticsService(metric: PerformanceMetric) {
  // Example: Forward to Google Analytics, Mixpanel, or custom service
  
  // Google Analytics 4 Measurement Protocol (example)
  if (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET) {
    try {
      const response = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: generateClientId(metric.userAgent),
          events: [{
            name: 'performance_metric',
            parameters: {
              metric_name: metric.metric,
              metric_value: metric.value,
              metric_context: metric.context,
              page_location: metric.url,
              custom_parameter_1: 'qwik_checkout'
            }
          }]
        })
      });
      
      if (!response.ok) {
        console.warn('Failed to send metric to GA4:', response.statusText);
      }
    } catch (error) {
      console.warn('Error forwarding to GA4:', error);
    }
  }
  
  // Example: Custom analytics service
  if (process.env.CUSTOM_ANALYTICS_ENDPOINT) {
    try {
      await fetch(process.env.CUSTOM_ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.ANALYTICS_API_KEY}`
        },
        body: JSON.stringify({
          event: 'performance_metric',
          properties: {
            metric_name: metric.metric,
            metric_value: metric.value,
            context: metric.context,
            url: metric.url,
            timestamp: metric.timestamp,
            source: 'qwik_checkout'
          }
        })
      });
    } catch (error) {
      console.warn('Error forwarding to custom analytics:', error);
    }
  }
}

async function storeMetricInDatabase(metric: PerformanceMetric) {
  // Example: Store in database for analysis
  // This would typically use your database ORM/client
  
  try {
    // Example with a hypothetical database client
    // await db.performanceMetrics.create({
    //   data: {
    //     metric: metric.metric,
    //     value: metric.value,
    //     context: metric.context,
    //     timestamp: new Date(metric.timestamp),
    //     userAgent: metric.userAgent,
    //     url: metric.url
    //   }
    // });
    
    // For now, just log that we would store it
    console.log('Would store metric in database:', metric.metric, metric.value);
  } catch (error) {
    console.warn('Error storing metric in database:', error);
  }
}

function generateClientId(userAgent: string): string {
  // Generate a simple client ID based on user agent
  // In production, you'd want a more sophisticated approach
  const hash = userAgent.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  return Math.abs(hash).toString();
}

// GET endpoint for health check
export const onGet: RequestHandler = async ({ json }) => {
  throw json(200, { 
    status: 'Analytics endpoint active',
    timestamp: new Date().toISOString()
  });
};
