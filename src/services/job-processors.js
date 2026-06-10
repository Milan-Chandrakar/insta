import { publishScheduledCarouselIntake, runWhatsAppIntakeOperation, finalizeIntakeOperation } from './workflow.js';

export function registerDefaultJobProcessors(registerJobProcessor) {
  registerJobProcessor('process-whatsapp-intake', runWhatsAppIntakeOperation);
  registerJobProcessor('publish-carousel-intake', publishScheduledCarouselIntake);
  registerJobProcessor('finalize-intake', finalizeIntakeOperation);
}
