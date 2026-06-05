export interface PaymentError {
  message: string;
  isRetryable: boolean;
  retryDelayMs?: number;
  errorCode?: string;
  category?: 'network' | 'validation' | 'system' | 'user';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  userAction?: string;
}

export class PaymentErrorHandler {
  /**
   * Handle payment errors with appropriate user-friendly messages
   */
  handlePaymentError(error: any, context: string): PaymentError {
    console.error(`[PaymentErrorHandler] ${context}:`, error);

    if (!error) {
      return {
        message: 'An unknown payment error occurred',
        isRetryable: false,
        category: 'system',
        severity: 'medium'
      };
    }

    // Network errors
    if (error.name === 'NetworkError' || error.code === 'NETWORK_ERROR') {
      return {
        message: 'Network connection failed. Please check your internet connection and try again.',
        isRetryable: true,
        retryDelayMs: 2000,
        errorCode: 'NETWORK_ERROR',
        category: 'network',
        severity: 'medium',
        userAction: 'Check your internet connection and try again'
      };
    }

    // Settlement-specific errors
    if (context.includes('settlement') || context.includes('settle')) {
      return this.handleSettlementError(error);
    }

    // GraphQL errors
    if (error.message && typeof error.message === 'string') {
      if (error.message.includes('fetch')) {
        return {
          message: 'Connection failed. Please try again.',
          isRetryable: true,
          retryDelayMs: 1000,
          errorCode: 'CONNECTION_FAILED',
          category: 'network',
          severity: 'medium',
          userAction: 'Try again in a moment'
        };
      }

      if (error.message.includes('timeout')) {
        return {
          message: 'Request timed out. Please try again.',
          isRetryable: true,
          retryDelayMs: 2000,
          errorCode: 'TIMEOUT',
          category: 'network',
          severity: 'medium',
          userAction: 'Try again in a moment'
        };
      }

      if (error.message.includes('already settled')) {
        return {
          message: 'This payment has already been processed successfully.',
          isRetryable: false,
          errorCode: 'ALREADY_SETTLED',
          category: 'validation',
          severity: 'low',
          userAction: 'No action needed - payment is complete'
        };
      }

      if (error.message.includes('order not found')) {
        return {
          message: 'Order not found. Please contact support.',
          isRetryable: false,
          errorCode: 'ORDER_NOT_FOUND',
          category: 'validation',
          severity: 'high',
          userAction: 'Contact customer support'
        };
      }
    }

    // Generic error
    return {
      message: error.message || 'Payment processing failed. Please try again.',
      isRetryable: true,
      retryDelayMs: 1000,
      errorCode: 'GENERIC_ERROR',
      category: 'system',
      severity: 'medium',
      userAction: 'Try again or contact support if the problem persists'
    };
  }

  /**
   * Handle settlement-specific errors
   */
  private handleSettlementError(error: any): PaymentError {
    const message = error.message?.toLowerCase() || '';

    if (message.includes('payment not found')) {
      return {
        message: 'Payment session has expired. Please start over.',
        isRetryable: false,
        errorCode: 'PAYMENT_NOT_FOUND',
        category: 'validation',
        severity: 'medium',
        userAction: 'Start a new payment'
      };
    }

    if (message.includes('already settled')) {
      return {
        message: 'This payment has already been completed successfully.',
        isRetryable: false,
        errorCode: 'ALREADY_SETTLED',
        category: 'validation',
        severity: 'low',
        userAction: 'No action needed'
      };
    }

    if (message.includes('payment service not available')) {
      return {
        message: 'Payment service is temporarily unavailable. Please try again in a few moments.',
        isRetryable: true,
        retryDelayMs: 5000,
        errorCode: 'SERVICE_UNAVAILABLE',
        category: 'system',
        severity: 'medium',
        userAction: 'Try again in a few moments'
      };
    }

    return {
      message: 'Payment settlement failed. Please try again.',
      isRetryable: true,
      retryDelayMs: 2000,
      errorCode: 'SETTLEMENT_FAILED',
      category: 'system',
      severity: 'medium',
      userAction: 'Try again or contact support'
    };
  }
}
