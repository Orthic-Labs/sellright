// SheerID Verification Types for Frontend
import type { QRL } from '@qwik.dev/core';

export interface VerificationProgram {
  id: string;
  name: string;
  segment: string;
  discountPercent: number;
  category: string;
  description: string;
  sheerIdProgramId: string;
}

// Frontend program configurations (moved from backend)
export const VERIFICATION_PROGRAMS: VerificationProgram[] = [
  {
    id: 'military',
    name: 'US Military',
    segment: 'US_MILITARY',
    discountPercent: 20,
    category: 'military',
    description: 'Active duty, veterans, and military families',
    sheerIdProgramId: '62fb8387ffe3e916af05ce22'
  },
  {
    id: 'first_responder',
    name: 'First Responder',
    segment: 'US_FIRST_RESPONDER',
    discountPercent: 20,
    category: 'first_responder',
    description: 'Police, firefighters, EMTs, and paramedics',
    sheerIdProgramId: '63235d2ce445913797c137d4'
  },
  {
    id: 'teacher',
    name: 'Teacher',
    segment: 'US_TEACHER',
    discountPercent: 15,
    category: 'teacher',
    description: 'K-12 teachers and educational staff',
    sheerIdProgramId: '66394380141e0119a76dfaa1'
  },
  {
    id: 'student',
    name: 'Student',
    segment: 'US_STUDENT',
    discountPercent: 15,
    category: 'student',
    description: 'College and university students',
    sheerIdProgramId: '66394477141e0119a76e032b'
  },
  {
    id: 'medical',
    name: 'Medical',
    segment: 'US_HEALTHCARE',
    discountPercent: 20,
    category: 'medical',
    description: 'Healthcare workers and medical professionals',
    sheerIdProgramId: '63235d9ae445913797c14132'
  },
  {
    id: 'senior',
    name: 'Young Adults & Seniors',
    segment: 'US_SENIOR',
    discountPercent: 15,
    category: 'senior',
    description: 'Young adults and senior citizens',
    sheerIdProgramId: '663944c3141e0119a76e0670'
  }
];

export interface VerificationData {
  programId: string;
  category: string;
  discountPercent: number;
  verifiedAt: string;
  expiresAt: string;
}

export interface CustomerVerificationStatus {
  hasVerifications: boolean;
  activeVerifications: string[];
  verifications: VerificationData[];
  metadata: any;
  availablePrograms: VerificationProgram[];
}

export interface InitiateVerificationResult {
  programId: string;
  sheerIdProgramId: string;
  customerId: string;
  segment: string;
  category: string;
  metadata: any;
}

export interface VerificationModalProps {
  isOpen: boolean;
  customerId?: string;
  onClose$: QRL<() => void>;
}
