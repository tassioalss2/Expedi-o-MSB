-- Tipos de caixa / contêiner
CREATE TABLE IF NOT EXISTS tipos_caixa (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo    VARCHAR(100) UNIQUE NOT NULL,
  descricao VARCHAR(200),
  ativo     BOOLEAN DEFAULT TRUE
);

-- Itens de cubagem por pedido (múltiplos tipos de caixa)
CREATE TABLE IF NOT EXISTS cubagem_itens (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo_caixa_id    UUID REFERENCES tipos_caixa(id),
  tipo_caixa_nome  VARCHAR(100),
  quantidade       INTEGER NOT NULL DEFAULT 1,
  criado_em        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

GRANT ALL ON tipos_caixa TO anon;
GRANT ALL ON cubagem_itens TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon;

-- Insere os 37 tipos de caixa
INSERT INTO tipos_caixa (codigo, descricao) VALUES
  ('Caix Speed Cross',        '(C 1,19 x L 0,17 x A 0,11)'),
  ('Caixa Amarela',           'Caixa Cubo (30,0 x 26,5 x 34,5)'),
  ('Caixa Bainha Osc',        'Caixa Bainha Osc (C 1,18 x L 0,17 x A 0,05)'),
  ('Caixa Bainha Osc P1',     'Caixa Bainha Osc (C 0,94 x L 0,17 x A 0,05)'),
  ('Caixa Bainha Persona',    'Caixa Bainha Osc (C 0,94 x L 0,17 x A 0,11)'),
  ('Caixa Branca',            'Caixa Bainha Média (90,7 x 33,8 x 18,4)'),
  ('Caixa CAC',               'Caixa CAC - (C 1,25 x L 0,11 x A 0,03)'),
  ('Caixa Capa Gaveta',       '(C 1,14 x L 0,17 x A 0,05)'),
  ('Caixa drenagem',          '(45 x 42 x 27)'),
  ('Caixa Dreno',             'Caixa Dreno (C 45,0 x L 43,0 x A 28,0)'),
  ('Caixa G Branca',          'Caixa G Branca (44 x 25 x 10)'),
  ('Caixa KDL M1',            'Caixa KDL M1 (C 58,0 x L 44,0 x A 27,0)'),
  ('Caixa KDL M2',            'Caixa KDL M2 (C 56,0 x L 33,0 x A 27,0)'),
  ('Caixa KDL P1',            'Caixa KDL P1 (C 21,0 x L 28,0 x A 24,0)'),
  ('Caixa Kit Branca',        'Caixa Kit Branca (35 x 27 x 14)'),
  ('Caixa Kit Insuflador',    'Caixa Kit Insuflador (73 x 37 x 30)'),
  ('Caixa M Branca',          'Caixa M Branca (28 x 21 x 11)'),
  ('CAIXA P',                 'C0,28XL0,21XA0,11'),
  ('Caixa P Branca',          'Caixa P Branca (25 x 23 x 13)'),
  ('Caixa Prata',             'Caixa Bainha Grande (120,7 x 33,8 x 18,4)'),
  ('Caixa Speed Cross',       '(C 1,21 x L 0,17 x A 0,6)'),
  ('caixa ureterescopio',     '(Cx 1,00 x L 0,18 x A 0,6)'),
  ('Caixa Verde',             'Caixa Grande (57,0 x 26,5 x 34,5)'),
  ('Caixa Vermelha',          'Caixa Média (57,0 x 26,5 x 17,3)'),
  ('Contêiner Agrupado',      'Agrupado (57,0 x 26,5 x 34,5)'),
  ('Contêiner Agrupado 2',    'Caixa Média (57,0 x 26,5 x 17,3)'),
  ('Conteiner Agrupado 3',    'Caixa Cubo (30,0 x 26,5 x 34,5)'),
  ('Envelope',                'Envelope P/ Amostras'),
  ('Envelope P1',             'Envelope P/ Amostras 2'),
  ('Personal Speed Cross',    '(C 1,22 x L 0,17 x A 0,18)'),
  ('Personalizado',           'Caixa Personalizada (28 x 36 x 30)'),
  ('Personalizado 2',         'Caixa Personalizada Branca (27,0 x 21 x 14)'),
  ('Personalizado 3',         'Caixa Personalizada 3 (C 0,94 x L 0,17 x A 0,27)'),
  ('Personalizado 4',         'Caixa Personalizada 4 (5 x 17 x 31)'),
  ('PERSONALIZADO 5',         'Caixa personalizada 5 (67 x 36 x 28)'),
  ('Vários Contêineres',      'Caixa Kit Insuflador (73 x 37 x 30)'),
  ('Vários Contêineres G',    'Caixa Grande (57 x 27 x 35)')
ON CONFLICT (codigo) DO NOTHING;

SELECT COUNT(*) AS tipos_inseridos FROM tipos_caixa;
