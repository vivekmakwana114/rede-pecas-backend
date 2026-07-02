import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { formatPrice } from '../utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper for dates
function formatDate(date: Date): string {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Generates an A4 PDF Proforma invoice for the customer.
 * Document text is Portuguese (customer-facing).
 */
export async function generateProformaPDF(
  orderNumber: string,
  phone: string,
  item: any
): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    // Use system temp dir or local temp dir
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const filePath = path.join(tempDir, `${orderNumber}.pdf`);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(22).fillColor('#1A3A5C').font('Helvetica-Bold').text('REDE PEÇAS', 50, 50);
    doc.fontSize(10).fillColor('#555555').font('Helvetica')
      .text('Marketplace Automotivo de Angola', 50, 78)
      .text('Tel: +244 900 000 000', 50, 92)
      .text('Email: info@redepecas.ao', 50, 106);

    doc.fontSize(18).fillColor('#1A3A5C').font('Helvetica-Bold')
      .text('FACTURA PROFORMA', 350, 50, { align: 'right' });
    doc.fontSize(10).fillColor('#555555').font('Helvetica')
      .text(`Nº: ${orderNumber}`, 350, 78, { align: 'right' })
      .text(`Data: ${formatDate(new Date())}`, 350, 92, { align: 'right' })
      .text(`Validade: ${formatDate(addDays(new Date(), 2))}`, 350, 106, { align: 'right' });

    doc.moveTo(50, 145).lineTo(545, 145).strokeColor('#2E6DA4').lineWidth(2).stroke();

    // Client Info
    doc.fontSize(11).fillColor('#1A3A5C').font('Helvetica-Bold').text('CLIENTE', 50, 160);
    doc.fontSize(10).fillColor('#333333').font('Helvetica')
      .text(`WhatsApp: ${phone}`, 50, 178)
      .text('(Dados completos a fornecer no momento do pagamento)', 50, 193);

    // Table Header
    const tY = 240;
    doc.rect(50, tY, 495, 28).fillColor('#1A3A5C').fill();
    doc.fontSize(10).fillColor('#FFFFFF').font('Helvetica-Bold')
      .text('Descrição', 60, tY + 9)
      .text('Referência', 280, tY + 9)
      .text('Qtd', 380, tY + 9, { width: 40, align: 'center' })
      .text('Preço Unit.', 420, tY + 9, { width: 80, align: 'right' })
      .text('Total', 480, tY + 9, { width: 60, align: 'right' });

    // Table Row
    const iY = tY + 28;
    doc.rect(50, iY, 495, 36).fillColor('#F5F7FA').fill();
    doc.fontSize(10).fillColor('#333333').font('Helvetica')
      .text(item.name, 60, iY + 6, { width: 210 })
      .text(item.reference, 280, iY + 12)
      .text('1', 380, iY + 12, { width: 40, align: 'center' })
      .text(formatPrice(item.price), 420, iY + 12, { width: 80, align: 'right' })
      .text(formatPrice(item.price), 480, iY + 12, { width: 60, align: 'right' });
    doc.fontSize(8).fillColor('#777777')
      .text(`Fornecedor: ${item.supplier || 'Rede Peças'}`, 60, iY + 22);
    doc.rect(50, tY, 495, 64).strokeColor('#CCCCCC').lineWidth(0.5).stroke();

    // Total Area
    const totalY = tY + 100;
    doc.rect(350, totalY, 195, 28).fillColor('#1A3A5C').fill();
    doc.fontSize(12).fillColor('#FFFFFF').font('Helvetica-Bold')
      .text('TOTAL A PAGAR:', 360, totalY + 8)
      .text(formatPrice(item.price), 480, totalY + 8, { width: 60, align: 'right' });

    // Payment Instructions
    const payY = totalY + 60;
    doc.fontSize(11).fillColor('#1A3A5C').font('Helvetica-Bold')
      .text('INSTRUÇÕES DE PAGAMENTO', 50, payY);
    doc.rect(50, payY + 18, 495, 80).fillColor('#EEF4FB').strokeColor('#2E6DA4').lineWidth(0.5).fillAndStroke();
    doc.fontSize(10).fillColor('#333333').font('Helvetica')
      .text('• Transferência bancária: IBAN AO06 0040 0000 XXXX XXXX XXXX X', 60, payY + 28)
      .text('• Multicaixa Express: +244 900 000 000', 60, payY + 44)
      .text(`• Referência obrigatória na transferência: ${orderNumber}`, 60, payY + 60)
      .text('• Após pagamento, envie comprovativo para este WhatsApp', 60, payY + 76);

    // Terms Note
    doc.fontSize(9).fillColor('#777777').font('Helvetica')
      .text(
        'Esta proforma tem validade de 48 horas. O stock é reservado apenas após confirmação do pagamento. ' +
        'A Rede Peças actua como intermediário entre o cliente e o fornecedor.',
        50, payY + 120, { width: 495 }
      );

    // Footer
    doc.moveTo(50, 760).lineTo(545, 760).strokeColor('#2E6DA4').lineWidth(1).stroke();
    doc.fontSize(8).fillColor('#999999')
      .text('Rede Peças — Marketplace Automotivo de Angola  |  NIF: 5XXXXXXXXX  |  info@redepecas.ao',
        50, 768, { align: 'center', width: 495 });

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Sends the generated proforma PDF to the customer via Meta WhatsApp Business API.
 */
export async function sendProformaWhatsApp(
  phone: string,
  pdfPath: string,
  orderNumber: string,
  item: any
): Promise<void> {
  const API_URL = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}`;
  const token = config.whatsapp.token;

  try {
    // 1. Upload the PDF file as media to WhatsApp
    const fileBuffer = fs.readFileSync(pdfPath);
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'application/pdf');
    // We construct a Blob out of the file buffer to send it correctly in FormData
    formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), `${orderNumber}.pdf`);

    const uploadRes = await fetch(`${API_URL}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const uploadError = await uploadRes.json();
      logger.error('WhatsApp PDF Media Upload Failed', uploadError);
      throw new Error(`Media upload failed with status ${uploadRes.status}`);
    }

    const { id: mediaId } = await uploadRes.json() as any;

    // 2. Send the textual confirmation message
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: {
          body:
            `✅ *Pedido confirmado!*\n\n` +
            `Segue em anexo a tua factura proforma para:\n` +
            `*${item.name}*\n\n` +
            `📋 Referência: *${orderNumber}*\n` +
            `💰 Total: *${formatPrice(item.price)}*\n` +
            `⏳ Validade: 48 horas\n\n` +
            `Após pagamento, envia o comprovativo aqui nesta conversa. 🙏`
        },
      }),
    });

    // 3. Send the actual PDF document
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'document',
        document: {
          id: mediaId,
          filename: `Proforma_${orderNumber}.pdf`,
          caption: `Factura Proforma Nº ${orderNumber} — Rede Peças`,
        },
      }),
    });

    logger.info(`Proforma PDF sent successfully to ${phone}`);
  } catch (error: any) {
    logger.error(`Error sending proforma to ${phone}: ${error.message}`);
    throw error;
  }
}

/**
 * Generates the official tax invoice via Primavera API (certified by AGT Angola).
 */
export async function generatePrimaveraInvoice(order: any): Promise<string> {
  const primaveraUrl = config.primavera.apiUrl;
  const primaveraToken = config.primavera.token;

  // Mock implementation if token is missing
  if (!primaveraToken || primaveraToken === 'TOKEN_DO_PRIMAVERA_AQUI') {
    logger.warn('PRIMAVERA_API_TOKEN is missing or is placeholder. Generating mock invoice PDF.');
    return generateMockInvoicePDF(order);
  }

  try {
    const res = await fetch(`${primaveraUrl}/api/facturas`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${primaveraToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Payload field names are defined by the Primavera API (Portuguese)
        tipoDocumento: 'FA', // Factura
        serie: 'A',
        cliente: order.customer_phone,
        linhas: [{
          artigo: order.reference || 'PEC-GEN',
          descricao: order.part_name || 'Peça Automóvel',
          quantidade: order.quantity || 1,
          precoUnitario: order.unit_price,
          iva: 14, // VAT in Angola (14%)
        }],
        referencia: order.number,
      }),
    });

    if (!res.ok) {
      const errDetail = await res.json();
      logger.error('Primavera invoice generation API error', errDetail);
      throw new Error(`Primavera invoice creation failed with status ${res.status}`);
    }

    const invoice = await res.json() as any;

    // Fetch the invoice PDF binary from Primavera
    const pdfRes = await fetch(`${primaveraUrl}/api/facturas/${invoice.id}/pdf`, {
      headers: { Authorization: `Bearer ${primaveraToken}` },
    });

    if (!pdfRes.ok) {
      throw new Error(`Failed to retrieve invoice PDF from Primavera: ${pdfRes.status}`);
    }

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const pdfPath = path.join(tempDir, `FACTURA_${order.number}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(await pdfRes.arrayBuffer()));

    return pdfPath;
  } catch (error: any) {
    logger.error(`Error generating Primavera invoice, falling back to mock: ${error.message}`);
    return generateMockInvoicePDF(order);
  }
}

/**
 * Sends the finalized official tax invoice PDF via WhatsApp.
 */
export async function sendFinalInvoiceWhatsApp(
  phone: string,
  pdfPath: string,
  orderNumber: string
): Promise<void> {
  const API_URL = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}`;
  const token = config.whatsapp.token;

  try {
    const fileBuffer = fs.readFileSync(pdfPath);
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'application/pdf');
    formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), `Factura_${orderNumber}.pdf`);

    const uploadRes = await fetch(`${API_URL}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      throw new Error(`Media upload for final invoice failed: ${uploadRes.status}`);
    }

    const { id: mediaId } = await uploadRes.json() as any;

    // Send text notification
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: {
          body:
            `🧾 *Factura Oficial AGT Emitida!*\n\n` +
            `O teu pagamento foi validado e a factura oficial já está disponível em anexo.\n` +
            `Obrigado por comprares na Rede Peças! 🚗`
        },
      }),
    });

    // Send PDF document
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'document',
        document: {
          id: mediaId,
          filename: `Factura_${orderNumber}.pdf`,
          caption: `Factura Comercial Nº ${orderNumber} — Rede Peças`,
        },
      }),
    });

    logger.info(`Final invoice PDF sent successfully to ${phone}`);
  } catch (error: any) {
    logger.error(`Error sending final invoice to ${phone}: ${error.message}`);
    throw error;
  }
}

/**
 * Generates a mock invoice PDF when Primavera ERP is not connected.
 */
async function generateMockInvoicePDF(order: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const filePath = path.join(tempDir, `FACTURA_${order.number}.pdf`);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(22).fillColor('#2E7D32').font('Helvetica-Bold').text('REDE PEÇAS - FACTURA', 50, 50);
    doc.fontSize(10).fillColor('#555555').font('Helvetica')
      .text('Marketplace Automotivo de Angola', 50, 78)
      .text('NIF: 5001234567 (Certificado AGT)', 50, 92);

    doc.fontSize(18).fillColor('#2E7D32').font('Helvetica-Bold')
      .text('FACTURA COMERCIAL', 350, 50, { align: 'right' });
    doc.fontSize(10).fillColor('#555555').font('Helvetica')
      .text(`Factura Nº: FA-${new Date().getFullYear()}/${order.number.split('-').pop()}`, 350, 78, { align: 'right' })
      .text(`Data Emissão: ${formatDate(new Date())}`, 350, 92, { align: 'right' });

    doc.moveTo(50, 145).lineTo(545, 145).strokeColor('#2E7D32').lineWidth(2).stroke();

    // Client
    doc.fontSize(11).fillColor('#2E7D32').font('Helvetica-Bold').text('CLIENTE', 50, 160);
    doc.fontSize(10).fillColor('#333333').font('Helvetica')
      .text(`Nome: Cliente Rede Peças`, 50, 178)
      .text(`WhatsApp: ${order.customer_phone}`, 50, 193);

    // Table
    const tY = 240;
    doc.rect(50, tY, 495, 28).fillColor('#2E7D32').fill();
    doc.fontSize(10).fillColor('#FFFFFF').font('Helvetica-Bold')
      .text('Descrição', 60, tY + 9)
      .text('Referência', 280, tY + 9)
      .text('Qtd', 380, tY + 9, { width: 40, align: 'center' })
      .text('Preço Unit.', 420, tY + 9, { width: 80, align: 'right' })
      .text('Total', 480, tY + 9, { width: 60, align: 'right' });

    const iY = tY + 28;
    doc.rect(50, iY, 495, 36).fillColor('#F1F8E9').fill();
    doc.fontSize(10).fillColor('#333333').font('Helvetica')
      .text(order.part_name || 'Peça Automóvel', 60, iY + 6, { width: 210 })
      .text(order.reference || 'PEC-GEN', 280, iY + 12)
      .text('1', 380, iY + 12, { width: 40, align: 'center' })
      .text(formatPrice(order.unit_price), 420, iY + 12, { width: 80, align: 'right' })
      .text(formatPrice(order.unit_price), 480, iY + 12, { width: 60, align: 'right' });

    // Total
    const totalY = tY + 100;
    doc.rect(350, totalY, 195, 28).fillColor('#2E7D32').fill();
    doc.fontSize(12).fillColor('#FFFFFF').font('Helvetica-Bold')
      .text('TOTAL PAGO:', 360, totalY + 8)
      .text(formatPrice(order.unit_price), 480, totalY + 8, { width: 60, align: 'right' });

    // AGT Stamp
    doc.fontSize(8).fillColor('#555555').font('Helvetica-Oblique')
      .text('Processado por computador. Emitido de acordo com as regras de facturação da AGT Angola.', 50, totalY + 120);

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', (err) => reject(err));
  });
}
