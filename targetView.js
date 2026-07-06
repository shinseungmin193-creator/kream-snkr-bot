const fs = require('fs');
const path = require('path');

const targets = JSON.parse(fs.readFileSync('update_targets.json', 'utf8'));

const rows = targets.map((item, index) => {
  const myPrice = Number(item.myPrice || 0);
  const lowestPrice = Number(item.lowestPrice || 0);
  const diff = myPrice - lowestPrice;

  return `
    <tr>
      <td>${index + 1}</td>
      <td>${item.koreanName || item.name || item.productName || ''}</td>
      <td>${item.option || ''}</td>
      <td>${myPrice.toLocaleString()}원</td>
      <td>${lowestPrice.toLocaleString()}원</td>
      <td>${diff.toLocaleString()}원</td>
    </tr>
  `;
}).join('');

const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>KREAM 수정 대상</title>
<style>
body {
  font-family: Arial, sans-serif;
  margin: 40px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  border: 1px solid #ddd;
  padding: 10px;
  text-align: center;
}
th {
  background: #f5f5f5;
}
tr:hover {
  background: #fafafa;
}
</style>
</head>
<body>

<h2>KREAM 수정 대상 ${targets.length}개</h2>

<table>
<thead>
<tr>
  <th>No</th>
  <th>상품명</th>
  <th>옵션</th>
  <th>현재가</th>
  <th>최저가</th>
  <th>차액</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>

</body>
</html>
`;

const filePath = path.join(__dirname, 'public', 'target_view.html');
fs.writeFileSync(filePath, html, 'utf8');

console.log(`public/target_view.html 생성 완료: ${targets.length}개`);