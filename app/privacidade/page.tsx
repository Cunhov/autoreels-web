import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Política de Privacidade",
	description: "Política de Privacidade do AutoReels",
};

export default function PrivacidadePage() {
	return (
		<div className="min-h-screen bg-ios-background text-ios-text">
			<div className="mx-auto max-w-2xl px-6 py-16">
				<h1 className="text-2xl font-bold mb-2">Política de Privacidade</h1>
				<p className="text-ios-text-secondary text-sm mb-8">
					Última atualização: 1 de setembro de 2026
				</p>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">1. Dados que coletamos</h2>
					<p className="text-sm leading-relaxed mb-3">Coletamos os seguintes dados:</p>
					<ul className="list-disc list-inside text-sm leading-relaxed mb-3 space-y-1">
						<li>Dados da sua conta (e-mail, senha criptografada) usados para login.</li>
						<li>Credenciais de conexão das suas redes sociais (tokens de acesso do
							Instagram, YouTube e TikTok, armazenados de forma segura e usados
							apenas para publicar conteúdo autorizado por você).</li>
						<li>Conteúdo que você envia para a biblioteca (vídeos, imagens, legendas,
							tags e configurações de produtos de afiliados).</li>
						<li>Dados de agendamento e publicação (planners, histórico de posts e
							resultados de publicação).</li>
						<li>Dados de uso e diagnóstico (logs de erro, configurações de proxy)
							necessários para o funcionamento e a manutenção do serviço.</li>
					</ul>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">2. Como usamos seus dados</h2>
					<p className="text-sm leading-relaxed mb-3">
						Usamos seus dados exclusivamente para: operar e melhorar o serviço;
						publicar conteúdo nas redes sociais conforme suas instruções; sugerir
						produtos de afiliados relevantes; exibir painéis de agendamento e
						histórico; e garantir a segurança da plataforma.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">3. Compartilhamento</h2>
					<p className="text-sm leading-relaxed mb-3">
						Não vendemos seus dados pessoais. Compartilhamos dados apenas com:
						(a) as plataformas de redes sociais que você conecta, na medida
						necessária para publicar conteúdo por sua conta; (b) provedores de
						infraestrutura (hospedagem, banco de dados) que processam dados apenas
						sob nossas instruções; e (c) autoridades, quando exigido por lei.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">4. Segurança</h2>
					<p className="text-sm leading-relaxed mb-3">
						Utilizamos criptografia para dados em trânsito (HTTPS) e armazenamento
						de credenciais, além de controles de acesso e monitoramento. Tokens de
						redes sociais são tratados como segredos e nunca são exibidos em
						interfaces voltadas ao usuário final.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">5. Retenção e exclusão</h2>
					<p className="text-sm leading-relaxed mb-3">
						Mantemos seus dados enquanto sua conta estiver ativa. Você pode remover
						canais conectados, conteúdos e planners a qualquer momento. A exclusão
						da conta remove os dados pessoais, exceto quando a retenção for exigida
						por lei.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">6. Seus direitos (LGPD)</h2>
					<p className="text-sm leading-relaxed mb-3">
						Nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018), você
						pode solicitar: acesso, correção, portabilidade e exclusão dos seus
						dados, além de revogar autorizações de conexão com redes sociais a
						qualquer momento.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">7. Contato</h2>
					<p className="text-sm leading-relaxed">
						Para exercer seus direitos ou esclarecer dúvidas sobre esta Política,
						entre em contato pelo e-mail de suporte disponível na página de
						configurações do serviço.
					</p>
				</section>
			</div>
		</div>
	);
}