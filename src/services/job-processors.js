import { publishScheduledCarouselIntake, runWhatsAppIntakeOperation } from './workflow.js';

export function registerDefaultJobProcessors(registerJobProcessor) {
  registerJobProcessor('process-whatsapp-intake', runWhatsAppIntakeOperation);
  registerJobProcessor('publish-carousel-intake', publishScheduledCarouselIntake);
}
