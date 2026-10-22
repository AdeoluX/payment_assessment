import { assertTransition, isTerminal, allowedTransitions } from '../src/domain/status';
import { ConflictError } from '../src/error';

describe('Payment Status Transitions', () => {
    describe('allowedTransitions', () => {
        it('should correctly define allowed state paths', () => {
            expect(allowedTransitions.PENDING).toEqual(['PROCESSING']);
            expect(allowedTransitions.PROCESSING).toEqual(['SUCCESS', 'FAILED']);
            expect(allowedTransitions.SUCCESS).toEqual([]);
            expect(allowedTransitions.FAILED).toEqual([]);
        });
    });

    describe('assertTransition', () => {
        it('should allow valid transition from PENDING to PROCESSING', () => {
            expect(() => assertTransition('PENDING', 'PROCESSING')).not.toThrow();
        });

        it('should allow valid transition from PROCESSING to SUCCESS', () => {
            expect(() => assertTransition('PROCESSING', 'SUCCESS')).not.toThrow();
        });

        it('should allow valid transition from PROCESSING to FAILED', () => {
            expect(() => assertTransition('PROCESSING', 'FAILED')).not.toThrow();
        });

        it('should reject invalid skip from PENDING to SUCCESS', () => {
            expect(() => assertTransition('PENDING', 'SUCCESS')).toThrow(ConflictError);
        });

        it('should reject invalid skip from PENDING to FAILED', () => {
            expect(() => assertTransition('PENDING', 'FAILED')).toThrow(ConflictError);
        });

        it('should reject transitions from terminal state SUCCESS', () => {
            expect(() => assertTransition('SUCCESS', 'PROCESSING')).toThrow(ConflictError);
            expect(() => assertTransition('SUCCESS', 'FAILED')).toThrow(ConflictError);
        });

        it('should reject transitions from terminal state FAILED', () => {
            expect(() => assertTransition('FAILED', 'PROCESSING')).toThrow(ConflictError);
            expect(() => assertTransition('FAILED', 'SUCCESS')).toThrow(ConflictError);
        });

        it('should reject self-transitions', () => {
            expect(() => assertTransition('PENDING', 'PENDING')).toThrow(ConflictError);
            expect(() => assertTransition('PROCESSING', 'PROCESSING')).toThrow(ConflictError);
        });
    });

    describe('isTerminal', () => {
        it('should identify SUCCESS and FAILED as terminal', () => {
            expect(isTerminal('SUCCESS')).toBe(true);
            expect(isTerminal('FAILED')).toBe(true);
        });

        it('should identify PENDING and PROCESSING as non-terminal', () => {
            expect(isTerminal('PENDING')).toBe(false);
            expect(isTerminal('PROCESSING')).toBe(false);
        });
    });
});
