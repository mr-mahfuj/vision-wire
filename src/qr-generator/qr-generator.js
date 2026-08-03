let qr;
let currentText = '';

window.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('url');
    const generateButton = document.getElementById('generateQR');
    const saveButton = document.getElementById('saveQR');
    const regenerateButton = document.getElementById('regenerateQR');

    generateButton.addEventListener('click', generateQRcode);
    saveButton.addEventListener('click', saveQRcode);
    regenerateButton.addEventListener('click', regenerateQRcode);

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            generateQRcode();
        }
    });
});

function generateQRcode() {
    const input = document.getElementById('url');
    const container = document.getElementById('qrcode');
    const data = input.value.trim();

    if (!data) {
        alert('Please provide a URL or text to generate a QR code.');
        return;
    }

    currentText = data;
    container.innerHTML = '';

    qr = new QRCode(container, {
        text: data,
        width: 256,
        height: 256,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
    });
}

function saveQRcode() {
    const container = document.getElementById('qrcode');
    const canvas = container.querySelector('canvas');
    const img = container.querySelector('img');

    if (!canvas && !img) {
        alert('Generate a QR code before saving it.');
        return;
    }

    const downloadLink = document.createElement('a');
    downloadLink.download = 'vision-wire-qr.png';
    downloadLink.href = canvas ? canvas.toDataURL('image/png') : img.src;
    downloadLink.click();
}

function regenerateQRcode() {
    if (!currentText) {
        alert('Generate a QR code first so there is something to regenerate.');
        return;
    }

    generateQRcode();
}
